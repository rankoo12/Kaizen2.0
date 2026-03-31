import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext, SelectorEntry } from '../../types';
import type { IDOMPruner } from '../dom-pruner/interfaces';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';

interface PlaywrightPageLike {
  $(selector: string): Promise<unknown | null>;
}

export class LLMElementResolver implements IElementResolver {
  constructor(
    private readonly domPruner: IDOMPruner,
    private readonly llmGateway: ILLMGateway,
    private readonly observability: IObservability
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> {
    const span = this.observability.startSpan('resolver.resolve', { tenantId: context.tenantId });
    try {
      // 1. Early Exit for navigational/background actions that strictly do not target the DOM
      if (!step.targetDescription) {
        this.observability.log('info', 'resolver.early_exit', { reason: 'no target description', action: step.action });
        return { selectors: [], fromCache: false, cacheSource: null };
      }

      // 2. Extract strictly relevant elements from DOM via JavaScript execution
      const candidates = await this.domPruner.prune(context.page, step.targetDescription);
      
      if (candidates.length === 0) {
        this.observability.log('warn', 'resolver.no_candidates', { action: step.action });
        return { selectors: [], fromCache: false, cacheSource: null };
      }

      // 3. Delegate to OpenAI to read candidates and output structured JSON selector predictions
      const llmResult = await this.llmGateway.resolveElement(step, candidates, context.tenantId);
      
      // 4. Live Validation 
      // Protects the execution engine against LLM hallucinations
      const page = context.page as PlaywrightPageLike;
      const validSelectors: SelectorEntry[] = [];

      for (const sel of llmResult.selectors) {
        try {
          const elementHandle = await page.$(sel.selector);
          if (elementHandle !== null) {
            validSelectors.push(sel);
          } else {
            this.observability.increment('resolver.validation_failed', { strategy: sel.strategy });
          }
        } catch (e) {
          // Playwright natively throws if a CSS/XPath selector is structurally invalid
          this.observability.increment('resolver.validation_error', { strategy: sel.strategy });
        }
      }

      return {
        selectors: validSelectors,
        fromCache: false,  // Evaluated fresh by the LLM
        cacheSource: null
      };
    } finally {
      span.end();
    }
  }

  async recordSuccess(contentHash: string, domain: string, selectorUsed: string): Promise<void> {
    // Basic tracing. A CompositeElementResolver layer built later wraps this to do Redis persistence.
    this.observability.increment('resolver.record_success', { domain });
  }

  async recordFailure(contentHash: string, domain: string, selectorAttempted: string): Promise<void> {
    this.observability.increment('resolver.record_failure', { domain });
  }
}
