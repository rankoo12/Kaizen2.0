import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext, SelectorEntry, CandidateNode } from '../../types';
import type { IDOMPruner } from '../dom-pruner/interfaces';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';
import { getPool } from '../../db/pool';
import { appendOutcome, computeConfidence } from './confidence';

/**
 * Converts a CandidateNode into a compact text description for embedding.
 * Produces a stable, semantic string like: "button: Add to Cart [id=add-to-cart aria-label=Add to Cart]"
 * This vector is stored as element_embedding and used by ElementSimilarityStrategy
 * to find structurally similar elements across DOM changes without LLM calls.
 */
function serializeCandidateForEmbedding(candidate: CandidateNode): string {
  const attrs = Object.entries(candidate.attributes)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const text = candidate.textContent?.trim() || candidate.name || '';
  return `${candidate.role}: ${text}${attrs ? ` [${attrs}]` : ''}`.trim();
}

interface PlaywrightPageLike {
  $(selector: string): Promise<unknown | null>;
}

/**
 * Spec ref: Section 6.3 — LLMElementResolver
 *
 * Phase 2 additions over Phase 1:
 *  - Persists resolved selectors to selector_cache (Postgres)
 *  - Generates and stores step_embedding after every LLM resolution
 *  - recordSuccess / recordFailure update outcome_window and recompute confidence_score
 */
export class LLMElementResolver implements IElementResolver {
  constructor(
    private readonly domPruner: IDOMPruner,
    private readonly llmGateway: ILLMGateway,
    private readonly observability: IObservability,
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> {
    const span = this.observability.startSpan('resolver.resolve', { tenantId: context.tenantId });
    try {
      if (!step.targetDescription) {
        this.observability.log('info', 'resolver.early_exit', {
          reason: 'no target description',
          action: step.action,
        });
        return { selectors: [], fromCache: false, cacheSource: null };
      }

      const candidates = await this.domPruner.prune(context.page, step.targetDescription);

      if (candidates.length === 0) {
        this.observability.log('warn', 'resolver.no_candidates', { action: step.action });
        return { selectors: [], fromCache: false, cacheSource: null };
      }

      const llmResult = await this.llmGateway.resolveElement(step, candidates, context.tenantId);

      // Live DOM validation — discard hallucinated selectors
      const page = context.page as PlaywrightPageLike;
      const validSelectors: SelectorEntry[] = [];

      for (const sel of llmResult.selectors) {
        try {
          const handle = await page.$(sel.selector);
          if (handle !== null) {
            validSelectors.push(sel);
          } else {
            this.observability.increment('resolver.validation_failed', { strategy: sel.strategy });
          }
        } catch {
          this.observability.increment('resolver.validation_error', { strategy: sel.strategy });
        }
      }

      const selectorSet: SelectorSet = {
        selectors: validSelectors,
        fromCache: false,
        cacheSource: null,
      };

      // Persist to selector_cache + generate step_embedding + element_embedding (fire-and-forget)
      if (validSelectors.length > 0) {
        void this.persistToCache(step, context, selectorSet, candidates);
      }

      return selectorSet;
    } finally {
      span.end();
    }
  }

  async recordSuccess(contentHash: string, domain: string, selectorUsed: string): Promise<void> {
    this.observability.increment('resolver.record_success', { domain });
    await this.updateOutcomeWindow(contentHash, domain, true, selectorUsed);
  }

  async recordFailure(contentHash: string, domain: string, selectorAttempted: string): Promise<void> {
    this.observability.increment('resolver.record_failure', { domain });
    await this.updateOutcomeWindow(contentHash, domain, false, selectorAttempted);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async persistToCache(
    step: StepAST,
    context: ResolutionContext,
    selectorSet: SelectorSet,
    candidates: CandidateNode[],
  ): Promise<void> {
    try {
      const winningSelector = selectorSet.selectors[0].selector;

      // step_embedding: semantic intent of the NL step text
      const stepEmbedding = await this.llmGateway.generateEmbedding(step.rawText);

      // element_embedding: semantic description of the resolved DOM element (AX tree form).
      // Find the candidate that matches the winning selector; fall back to the top candidate.
      const winningCandidate =
        candidates.find(
          (c) => c.cssSelector === winningSelector || c.xpath === winningSelector,
        ) ?? candidates[0];
      const elementText = serializeCandidateForEmbedding(winningCandidate);
      const elementEmbedding = await this.llmGateway.generateEmbedding(elementText);

      const toSQL = (v: number[]) => '[' + v.join(',') + ']';

      await getPool().query(
        `INSERT INTO selector_cache
           (tenant_id, content_hash, domain, selectors, step_embedding, element_embedding)
         VALUES ($1, $2, $3, $4, $5::vector, $6::vector)
         ON CONFLICT (tenant_id, content_hash, domain)
         DO UPDATE SET
           selectors         = EXCLUDED.selectors,
           step_embedding    = EXCLUDED.step_embedding,
           element_embedding = EXCLUDED.element_embedding,
           updated_at        = now()`,
        [
          context.tenantId,
          step.contentHash,
          context.domain,
          JSON.stringify(selectorSet.selectors),
          toSQL(stepEmbedding),
          toSQL(elementEmbedding),
        ],
      );

      this.observability.increment('resolver.cache_write', { domain: context.domain });
    } catch (e: any) {
      // Fire-and-forget — a failed persist must never break the current run
      this.observability.log('warn', 'resolver.cache_write_failed', { error: e.message });
    }
  }

  private async updateOutcomeWindow(
    contentHash: string,
    domain: string,
    success: boolean,
    _selector: string,
  ): Promise<void> {
    try {
      const pool = getPool();

      // Fetch current window (RLS not required — internal operation using service role)
      const { rows } = await pool.query<{ outcome_window: boolean[] }>(
        `SELECT outcome_window FROM selector_cache
         WHERE content_hash = $1 AND domain = $2
         LIMIT 1`,
        [contentHash, domain],
      );

      if (rows.length === 0) return;

      const newWindow = appendOutcome(rows[0].outcome_window, success);
      const newScore = computeConfidence(newWindow);

      await pool.query(
        `UPDATE selector_cache
         SET outcome_window    = $1,
             confidence_score  = $2,
             last_verified_at  = CASE WHEN $3 THEN now() ELSE last_verified_at END,
             last_failed_at    = CASE WHEN NOT $3 THEN now() ELSE last_failed_at END,
             fail_count_window = CASE WHEN NOT $3 THEN fail_count_window + 1 ELSE fail_count_window END,
             updated_at        = now()
         WHERE content_hash = $4 AND domain = $5`,
        [JSON.stringify(newWindow), newScore, success, contentHash, domain],
      );
    } catch (e: any) {
      this.observability.log('warn', 'resolver.outcome_update_failed', { error: e.message });
    }
  }
}
