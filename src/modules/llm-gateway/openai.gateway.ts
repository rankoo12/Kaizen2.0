import { createHash } from 'crypto';
import { OpenAI } from 'openai';
import type { Redis } from 'ioredis';
import type { ILLMGateway } from './interfaces';
import type { StepAST, CandidateNode, LLMResolutionResult, CompactCandidate } from '../../types';
import type { IBillingMeter } from '../billing-meter/interfaces';
import type { IObservability } from '../observability/interfaces';

/**
 * Actions that can only target specific ARIA roles.
 * Filters out semantically impossible candidates before the LLM sees them —
 * e.g. a `type` action should never pick a `link` or `button`.
 * No hardcoded element lists: the constraint is purely role-based (ARIA spec).
 */
const ACTION_ROLE_ALLOWLIST: Record<string, string[]> = {
  type:   ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  select: ['combobox', 'listbox'],
  // click, assert_visible, scroll, press_key, navigate: no constraint (all roles valid)
};

function filterByActionRole(candidates: CandidateNode[], action: string): CandidateNode[] {
  const allowed = ACTION_ROLE_ALLOWLIST[action];
  if (!allowed) return candidates;
  const filtered = candidates.filter((c) => allowed.includes(c.role));
  // If filtering removed everything (e.g. page has no textboxes at all), fall back to all candidates
  // so the LLM can at least signal a "no match" rather than hallucinating from an empty list.
  return filtered.length > 0 ? filtered : candidates;
}

/**
 * Score candidates by word-overlap with the target description and return them
 * sorted descending. O(n) — no embeddings, no API calls.
 */
function scoreAndRankCandidates(candidates: CandidateNode[], target: string): CandidateNode[] {
  const words = target.toLowerCase().split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))   // strip quotes, punctuation
    .filter((w) => w.length > 2);
  if (words.length === 0) return candidates;

  return candidates
    .map((c) => {
      const haystack = [
        c.role, c.name, c.textContent,
        c.attributes['placeholder'] ?? '',
        c.attributes['aria-label'] ?? '',
        c.attributes['id'] ?? '',
        c.attributes['name'] ?? '',
        c.attributes['data-qa'] ?? '',
        c.attributes['data-test'] ?? '',
        c.attributes['data-testid'] ?? '',
      ].join(' ').toLowerCase();

      const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
      return { c, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ c }) => c);
}

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

  private buildDedupKey(contentHash: string, rawText: string, domain: string, candidates: CandidateNode[]): string {
    const fingerprint = candidates
      .map((c) => `${c.role}:${c.name}:${c.cssSelector}`)
      .sort()
      .join('|');
    // Version 1.1.0: rawText added to key so two steps that compile to the same
    // targetDescription but differ in wording produce distinct dedup entries.
    // Key format: llm:dedup:{targetHash}:{sha256} — the targetHash prefix makes it
    // pattern-matchable so verdict=failed can evict all dedup entries for a step.
    const raw = `resolveElement:1.1.0:${contentHash}:${rawText}:${domain}:${fingerprint}`;
    return `llm:dedup:${contentHash}:` + createHash('sha256').update(raw).digest('hex');
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

Action rules:
- "click"  : buttons, links, radio buttons, checkboxes, tabs, toggles — any element the user taps/checks/selects that is NOT a <select> dropdown
- "select" : ONLY for <select> dropdown elements (e.g. "choose from dropdown", "pick from list")
- "type"   : filling a text input or textarea
- "navigate": going to a URL

Radio buttons and checkboxes MUST use "click", never "select".

CRITICAL — value field rules:
- value MUST always be a JSON string (quoted), never a JSON number or boolean.
- For "choose day 11"   → value: "11"   (not 11)
- For "choose option 3" → value: "3"    (not 3)
- For "select 1997"     → value: "1997" (not 1997)
- Numbers extracted as the option to select MUST be quoted strings.
Return only valid JSON.`,
          },
          { role: 'user', content: rawText },
        ],
      });

      const jsonStr = response.choices[0].message.content;
      if (!jsonStr) throw new Error('Empty LLM response');

      const ast = JSON.parse(jsonStr) as StepAST;

      // Guard: LLMs sometimes emit numeric values without quotes (e.g. value: 11).
      // Playwright's selectOption rejects non-strings, so coerce at the boundary.
      if (ast.value !== null && ast.value !== undefined && typeof ast.value !== 'string') {
        (ast as any).value = String((ast as any).value);
      }

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
      const roleFiltered = filterByActionRole(candidates, step.action);
      const filtered = scoreAndRankCandidates(roleFiltered, step.targetDescription ?? '').slice(0, 7);
      const dedupKey = this.buildDedupKey(step.targetHash, step.rawText ?? '', '', filtered);

      if (this.redis) {
        const cached = await this.redis.get(dedupKey);
        if (cached) {
          this.observability.increment('llm.prompt_cache_hit');
          return { ...JSON.parse(cached), fromCache: true };
        }
      }

      // Detect which display names appear more than once — those entries get
      // a parentContext suffix so the LLM can tell them apart. Unique names
      // are left untouched to keep the prompt clean.
      const nameCounts = new Map<string, number>();
      for (const c of filtered) {
        const key = (c.name || c.textContent || '').toLowerCase().trim();
        nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
      }

      const promptCandidates = filtered
        .map((c: CandidateNode) => {
          const displayName = c.name || c.textContent || c.attributes['placeholder'] || '';
          const isAmbiguous = (nameCounts.get(displayName.toLowerCase().trim()) ?? 0) > 1;
          const contextSuffix = isAmbiguous && c.parentContext ? `  (in: "${c.parentContext}")` : '';
          return `[${c.kaizenId}] ${c.role}: "${displayName}"${contextSuffix}`;
        })
        .join('\n');

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Pick the UI element that best matches the test step target. Return JSON: { "kaizenId": "kz-N" }`,
          },
          {
            role: 'user',
            content: `Action: ${step.action} | Target: ${step.targetDescription}\nFull step: ${step.rawText}\nCandidates:\n${promptCandidates}`,
          },
        ],
      });

      const jsonStr = response.choices[0].message.content;
      if (!jsonStr) throw new Error('Empty LLM response');

      const result = JSON.parse(jsonStr) as { kaizenId?: string };
      const tokens = response.usage?.total_tokens ?? 0;
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;

      await this.billingMeter.emit({
        tenantId,
        eventType: 'LLM_CALL',
        quantity: tokens,
        unit: 'tokens',
        metadata: { model: 'gpt-4o-mini', purpose: 'resolveElement' },
      });

      // Map the returned kaizenId back to the pre-generated stable selectors.
      // The LLM's only job is disambiguation — selector generation is done by the DOM pruner.
      const pickedCandidate = filtered.find((c: CandidateNode) => c.kaizenId === result.kaizenId);
      const selectors = pickedCandidate?.selectorCandidates ?? [];

      // Build compact snapshot of what the LLM was shown, in the order it saw them.
      // parentContext is included so the debug UI can reconstruct the exact prompt line.
      const llmPromptedCandidates: CompactCandidate[] = filtered.map((c: CandidateNode) => ({
        kaizenId: c.kaizenId ?? '',
        role: c.role,
        name: c.name?.trim() || c.textContent?.trim() || '',
        selector: c.cssSelector,
        ...(c.parentContext ? { parentContext: c.parentContext } : {}),
      }));

      const resolution: LLMResolutionResult = {
        selectors,
        fromCache: false,
        promptTokens,
        completionTokens,
        templateVersion: '1.0.0',
        llmPickedKaizenId: result.kaizenId ?? null,
        llmPromptedCandidates,
      };

      if (this.redis) {
        // 1-hour TTL — short enough that a verdict=failed + rerun within the hour
        // won't be served stale wrong results from this cache.
        await this.redis.setex(dedupKey, 3_600, JSON.stringify(resolution));
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
