import { createHash } from 'crypto';
import { OpenAI } from 'openai';
import type { Redis } from 'ioredis';
import type { ILLMGateway } from './interfaces';
import type { StepAST, CandidateNode, LLMResolutionResult } from '../../types';
import type { IBillingMeter } from '../billing-meter/interfaces';
import type { IObservability } from '../observability/interfaces';

export class OpenAIGateway implements ILLMGateway {
  private openai: OpenAI;

  constructor(
    private readonly billingMeter: IBillingMeter,
    private readonly observability: IObservability,
    apiKey?: string,
    private readonly redis?: Redis,
  ) {
    this.openai = new OpenAI({
      apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? 'sk-mock-key',
    });
  }

  private buildDedupKey(contentHash: string, domain: string, candidates: CandidateNode[]): string {
    const fingerprint = candidates
      .map((c) => `${c.role}:${c.name}:${c.cssSelector}`)
      .sort()
      .join('|');
    const raw = `resolveElement:1.0.0:${contentHash}:${domain}:${fingerprint}`;
    return 'llm:dedup:' + createHash('sha256').update(raw).digest('hex');
  }

  async compileStep(rawText: string, tenantId: string): Promise<StepAST> {
    const span = this.observability.startSpan('llm.compileStep', { tenantId });
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a UI test compiler. Extract the user's intent into a JSON object matching this schema exactly:
{
  "action": "navigate" | "click" | "type" | "select" | "assert_visible" | "wait" | "press_key" | "scroll",
  "targetDescription": "string | null",
  "value": "string | null",
  "url": "string | null"
}
Return only valid JSON.`,
          },
          { role: 'user', content: rawText },
        ],
      });

      const jsonStr = response.choices[0].message.content;
      if (!jsonStr) throw new Error('Empty LLM response');

      const ast = JSON.parse(jsonStr) as StepAST;
      const tokens = response.usage?.total_tokens ?? 0;

      await this.billingMeter.emit({
        tenantId,
        eventType: 'LLM_CALL',
        quantity: tokens,
        unit: 'tokens',
        metadata: { model: 'gpt-4o-mini', purpose: 'compileStep' },
      });

      this.observability.increment('llm.tokens_used', { purpose: 'compileStep' });
      return { ...ast, rawText, contentHash: '' };
    } catch (error: any) {
      this.observability.log('error', 'llm.compileStep_failed', { error: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  async resolveElement(step: StepAST, candidates: CandidateNode[], tenantId: string): Promise<LLMResolutionResult> {
    const span = this.observability.startSpan('llm.resolveElement', { tenantId });
    try {
      const dedupKey = this.buildDedupKey(step.contentHash, '', candidates);

      if (this.redis) {
        const cached = await this.redis.get(dedupKey);
        if (cached) {
          this.observability.increment('llm.prompt_cache_hit');
          return { ...JSON.parse(cached), fromCache: true };
        }
      }

      const promptCandidates = candidates
        .map((c) => `ID: ${c.kaizenId} | Role: ${c.role} | Name: ${c.name} | Text: ${c.textContent}`)
        .join('\n');

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Given a test step and candidate UI elements, return the best selectors.
Output JSON schema:
{
  "selectors": [
    { "selector": "[data-kaizen-id='kz-1']", "strategy": "data-testid", "confidence": 0.95 }
  ]
}
Prefer data-kaizen-id selectors. Return up to 5, ordered by confidence descending.`,
          },
          {
            role: 'user',
            content: `Step Action: ${step.action}\nTarget: ${step.targetDescription}\nValue: ${step.value}\nCandidates:\n${promptCandidates}`,
          },
        ],
      });

      const jsonStr = response.choices[0].message.content;
      if (!jsonStr) throw new Error('Empty LLM response');

      const result = JSON.parse(jsonStr);
      const tokens = response.usage?.total_tokens ?? 0;
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;

      await this.billingMeter.emit({
        tenantId,
        eventType: 'LLM_CALL',
        quantity: tokens,
        unit: 'tokens',
        metadata: { model: 'gpt-4o', purpose: 'resolveElement' },
      });

      const resolution: LLMResolutionResult = {
        selectors: result.selectors ?? [],
        fromCache: false,
        promptTokens,
        completionTokens,
        templateVersion: '1.0.0',
      };

      if (this.redis) {
        await this.redis.setex(dedupKey, 86_400, JSON.stringify(resolution));
      }

      return resolution;
    } catch (error: any) {
      this.observability.log('error', 'llm.resolveElement_failed', { error: error.message });
      throw error;
    } finally {
      span.end();
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const span = this.observability.startSpan('llm.generateEmbedding');
    try {
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.trim(),
      });
      this.observability.increment('llm.embeddings_generated');
      return response.data[0].embedding;
    } catch (error: any) {
      this.observability.log('error', 'llm.generateEmbedding_failed', { error: error.message });
      throw error;
    } finally {
      span.end();
    }
  }
}
