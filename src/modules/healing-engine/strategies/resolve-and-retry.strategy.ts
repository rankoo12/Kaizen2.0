import type { IHealingStrategy } from '../interfaces';
import type { ClassifiedFailure, HealingContext, HealingAttempt } from '../../../types';
import type { ILLMGateway } from '../../llm-gateway/interfaces';
import type { IDOMPruner } from '../../dom-pruner/interfaces';
import type { IObservability } from '../../observability/interfaces';
import { tenantQuery } from '../../../db/transaction';
import { toVectorSQL } from '../../../utils/vector';
import { serializeCandidateForEmbedding } from '../../element-resolver/llm.element-resolver';
import { nameAbsent } from '../../element-resolver/name-fidelity';
import type { Redis } from 'ioredis';

type PageLike = {
  $(selector: string): Promise<unknown | null>;
  url?(): string;
};

const BUDGET_KEY = (tenantId: string) => `healing:resolve_retry:${tenantId}`;
const DEFAULT_MAX_PER_HOUR = 2;
const TTL_SECONDS = 3600;

/**
 * Hourly re-resolution budget per tenant. Env-overridable (read per call so
 * tests and long-lived workers see changes without a restart) because a suite
 * whose target site just changed can legitimately need many re-resolutions in
 * one run — the engine-robustness bench mutates a whole site at once, and a
 * production tenant pushing a redesign hits the same wall.
 * Spec: docs/specs/bench/spec-changing-sites.md
 */
function maxPerHour(): number {
  const raw = Number(process.env.HEAL_RESOLVE_RETRY_PER_HOUR);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_PER_HOUR;
}

/**
 * ResolveAndRetryStrategy — Priority 4
 * Spec ref: Section 10
 *
 * Triggers a fresh LLM element resolution, updates both step_embedding and
 * element_embedding in selector_cache on success, then retries the selector in DOM.
 *
 * Rate-limited: max 2 calls per tenant per hour by default (Redis counter);
 * override with HEAL_RESOLVE_RETRY_PER_HOUR for site-redesign bursts and the
 * changing-sites bench.
 * Handles: ELEMENT_REMOVED, ELEMENT_MUTATED
 */
export class ResolveAndRetryStrategy implements IHealingStrategy {
  readonly name = 'ResolveAndRetryStrategy';

  constructor(
    private readonly domPruner: IDOMPruner,
    private readonly llmGateway: ILLMGateway,
    private readonly redis: Redis,
    private readonly observability: IObservability,
  ) {}

  canHandle(failure: ClassifiedFailure): boolean {
    // ELEMENT_REMOVED / ELEMENT_MUTATED are the obvious re-resolve cases.
    // TIMING and ELEMENT_OBSCURED are included because a STALE CACHED selector
    // (the site renamed/moved an element) makes page.click wait and time out —
    // and the classifier can only prove SelectorGone when the selector encodes a
    // name (aria-label=/text=). Role/CSS-id selectors (most of Kaizen's cache)
    // can't be name-matched, so a genuinely-dead selector falls through to TIMING.
    // Re-resolution is rate-limited (2/tenant/hr) and runs AFTER AdaptiveWait, so a
    // real slow-load is still handled by waiting first; this only fires as a last
    // resort — exactly when a fresh LLM resolve is the right move.
    return (
      failure.failureClass === 'ELEMENT_REMOVED' ||
      failure.failureClass === 'ELEMENT_MUTATED' ||
      failure.failureClass === 'TIMING' ||
      failure.failureClass === 'ELEMENT_OBSCURED'
    );
  }

  async heal(failure: ClassifiedFailure, context: HealingContext): Promise<HealingAttempt> {
    const start = Date.now();

    // Enforce healing budget
    const budgetKey = BUDGET_KEY(context.tenantId);
    const current = await this.redis.incr(budgetKey);
    if (current === 1) await this.redis.expire(budgetKey, TTL_SECONDS);

    if (current > maxPerHour()) {
      this.observability.increment('healing.resolve_retry_budget_exceeded', {
        tenantId: context.tenantId,
      });
      return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
    }

    try {
      const page = context.page as PageLike;
      const step = failure.step;

      // ── Retry loop (finding #15) ──────────────────────────────────────────
      // The old single-shot re-resolve raced late-appearing targets: a banner
      // button that both RENDERS LATE and was RENAMED got re-resolved against
      // a DOM it was not in yet, and nothing ever tried again (proven live on
      // the nightmare cookie family — one case won the race, two lost it,
      // model-independent). The re-resolver now re-prunes and re-picks up to
      // three times within the step's remaining watchdog budget: the patience
      // belongs to the RESOLVER, not only to the wait-for-the-dead-selector
      // strategy ahead of it.
      const MAX_ATTEMPTS = 3;
      // Env-tunable like the hourly budget (read per call): tests set it to 1,
      // and a deployment can tighten or relax the between-attempt settle.
      const envWait = Number(process.env.HEAL_RESOLVE_RETRY_WAIT_MS);
      const RETRY_WAIT_MS = Number.isFinite(envWait) && envWait >= 0 ? envWait : 2_500;
      // Leave enough room after a wait for a prune + LLM pick + probe.
      const budgetAllows = (): boolean =>
        !context.deadlineAt || context.deadlineAt - Date.now() > RETRY_WAIT_MS + 6_000;

      // A zero-overlap pick kept as last resort (finding #16): it may still
      // heal the RUN on the final attempt — the downstream assert is the
      // safety net — but it must never be cached, and a later attempt that
      // finds a name-agreeing element always beats it.
      let lastResort: { selector: string } | null = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const candidates = await this.domPruner.prune(context.page, step.targetDescription ?? '');
        if (candidates.length > 0) {
          const llmResult = await this.llmGateway.resolveElement(step, candidates, context.tenantId);

          for (const sel of llmResult.selectors) {
            try {
              const handle = await page.$(sel.selector);
              if (handle === null) continue;

              // Name gate (finding #16): the picked element's own words must
              // share SOMETHING with the target. The closed-vault probe showed
              // a click-validated wrong pick ("Secret vault" healed onto
              // "Summon modal") being PERSISTED with heal provenance — which
              // the worker's name gates then trust. Zero overlap = wrong
              // element until a retry proves otherwise.
              const winner = candidates.find(
                (c) => c.cssSelector === sel.selector || c.xpath === sel.selector,
              ) ?? candidates[0];
              const descriptor = `${winner.name} ${winner.textContent} ${winner.role}`;
              if (nameAbsent(step.targetDescription, descriptor)) {
                this.observability.increment('healing.resolve_retry_name_absent', {
                  tenantId: context.tenantId,
                });
                lastResort = lastResort ?? { selector: sel.selector };
                continue; // a name-agreeing pick may exist later in the list, or on retry
              }

              // Persist the corrected selector (+ embeddings) into selector_cache so
              // the NEXT run serves the healed selector, not the stale one that just
              // failed. Keyed on targetHash (selector_cache.content_hash stores the
              // TARGET hash). Only name-agreeing picks ever reach this line.
              void this.persistHealedSelector(step, context, sel, candidates);

              this.observability.increment('healing.resolve_retry_success', {
                tenantId: context.tenantId,
              });
              return { succeeded: true, newSelector: sel.selector, durationMs: Date.now() - start };
            } catch {
              // try next selector
            }
          }
        }

        if (attempt < MAX_ATTEMPTS && budgetAllows()) {
          await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
        } else {
          break;
        }
      }

      if (lastResort) {
        // Final attempt exhausted and only a zero-overlap pick exists: heal
        // the RUN with it (an outcome assert downstream catches a wrong
        // element honestly), but NOTHING is persisted and no provenance is
        // earned — the self-shielding poison path of finding #16 is closed.
        this.observability.increment('healing.resolve_retry_last_resort', {
          tenantId: context.tenantId,
        });
        return { succeeded: true, newSelector: lastResort.selector, durationMs: Date.now() - start };
      }
    } catch (e: any) {
      this.observability.log('warn', 'healing.resolve_retry_error', { error: e.message });
    }

    return { succeeded: false, newSelector: null, durationMs: Date.now() - start };
  }

  private async persistHealedSelector(
    step: { targetHash: string; action: string; targetDescription: string | null },
    context: HealingContext,
    healed: { selector: string; strategy: string; confidence?: number },
    candidates: Array<{ role: string; name: string; cssSelector: string; xpath: string; attributes: Record<string, string>; textContent: string }>,
  ): Promise<void> {
    const targetHash = step.targetHash;
    try {
      // CRITICAL: embed the SAME canonical texts the resolver embeds on its own
      // write-back (`action + targetDescription`, serializeCandidateForEmbedding)
      // — the read-time semantic guard compares against those. The first cut
      // embedded step.rawText here and, under exact-text hash embeddings, every
      // healed row was REJECTED and deleted at the very next resolve
      // (cache_resolver.semantic_reject), so the heal un-learned itself and the
      // bench judged healed-not-learned forever (finding #5's second half).
      const stepEmbedding = await this.llmGateway.generateEmbedding(`${step.action} ${step.targetDescription ?? ''}`);

      const winner = candidates.find(
        (c) => c.cssSelector === healed.selector || c.xpath === healed.selector,
      ) ?? candidates[0];
      const pageUrl = (() => { try { return (context.page as PageLike).url?.(); } catch { return undefined; } })();
      const urlPath = pageUrl ? new URL(pageUrl).pathname : undefined;
      const elementEmbedding = await this.llmGateway.generateEmbedding(serializeCandidateForEmbedding(winner, urlPath));

      // Overwrite the stale selector with the healed one and restore confidence —
      // it was just validated against the live DOM (page.$ !== null), so the next
      // run should trust and serve it instead of the dead selector. GREATEST keeps
      // an already-higher confidence; the reset outcome window prevents the prior
      // failures from immediately demoting the corrected selector below the 0.4
      // serve threshold. The `healed` attribution key is what the resolver
      // surfaces as SelectorSet.healProvenance (bench finding #5).
      const selectorsJson = JSON.stringify([
        { selector: healed.selector, strategy: healed.strategy, confidence: healed.confidence ?? 0.9 },
      ]);
      if (context.domain) {
        // UPSERT, not UPDATE: by the time this strategy runs, the stale row has
        // usually been EVICTED by the worker's resolution-recovery gates — an
        // UPDATE then matches zero rows and the heal is never learned, so every
        // run re-fails and re-heals (judged healed-not-learned, GAP). Keyed on
        // the (tenant_id, content_hash, domain) unique index.
        await tenantQuery(
          context.tenantId,
          `INSERT INTO selector_cache
             (tenant_id, content_hash, domain, selectors, step_embedding, element_embedding,
              confidence_score, outcome_window, last_verified_at, attribution)
           VALUES ($5, $4, $6, $1::jsonb, $2::vector, $3::vector, 0.9, '[true]'::jsonb, now(),
                   jsonb_build_object('healed', jsonb_build_object('strategy', 'resolve_and_retry', 'at', now())))
           ON CONFLICT (tenant_id, content_hash, domain) DO UPDATE
           SET selectors         = EXCLUDED.selectors,
               step_embedding    = EXCLUDED.step_embedding,
               element_embedding = EXCLUDED.element_embedding,
               confidence_score  = GREATEST(selector_cache.confidence_score, 0.9),
               outcome_window    = '[true]'::jsonb,
               last_verified_at  = now(),
               updated_at        = now(),
               attribution       = COALESCE(selector_cache.attribution, '{}'::jsonb)
                                   || jsonb_build_object('healed', jsonb_build_object('strategy', 'resolve_and_retry', 'at', now()))`,
          [selectorsJson, toVectorSQL(stepEmbedding), toVectorSQL(elementEmbedding), targetHash, context.tenantId, context.domain],
        );
      } else {
        // No domain in context (an older caller): the row can only be updated in
        // place — correct when it survived, silently learns nothing when evicted.
        await tenantQuery(
          context.tenantId,
          `UPDATE selector_cache
           SET selectors         = $1::jsonb,
               step_embedding    = $2::vector,
               element_embedding = $3::vector,
               confidence_score  = GREATEST(confidence_score, 0.9),
               outcome_window    = '[true]'::jsonb,
               last_verified_at  = now(),
               updated_at        = now(),
               attribution       = COALESCE(attribution, '{}'::jsonb)
                                   || jsonb_build_object('healed', jsonb_build_object('strategy', 'resolve_and_retry', 'at', now()))
           WHERE content_hash = $4 AND tenant_id = $5`,
          [selectorsJson, toVectorSQL(stepEmbedding), toVectorSQL(elementEmbedding), targetHash, context.tenantId],
        );
      }
    } catch (e: any) {
      this.observability.log('warn', 'healing.embedding_update_failed', { error: e.message });
    }
  }
}
