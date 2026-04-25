import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext, SelectorEntry, CandidateNode, CompactCandidate } from '../../types';
import type { IDOMPruner } from '../dom-pruner/interfaces';
import type { ILLMGateway } from '../llm-gateway/interfaces';
import type { IObservability } from '../observability/interfaces';
import type { ISharedPoolService } from '../shared-pool/interfaces';
import type { Redis } from 'ioredis';
import { getPool } from '../../db/pool';
import { appendOutcome, computeConfidence } from './confidence';
import { toVectorSQL } from '../../utils/vector';
import { filterCandidatesByAction } from './action-role-filter';
import { invalidateRedisCache, isTransient } from './redis-cache.utils';

/**
 * Converts a CandidateNode into a compact semantic string for element_embedding.
 * Uses role + accessible name (AX-tree stable) plus an optional URL path suffix.
 *
 * The URL path suffix (`@ /login`) is critical for correctness: two elements with
 * identical role+name on different pages (e.g. "textbox: Email" on /login vs /register)
 * would otherwise produce identical vectors, making cosine similarity = 1.0 regardless
 * of threshold — a false positive that cannot be prevented by tuning alone.
 * Including the pathname makes each page's element embedding distinct.
 *
 * urlPath should be the normalized pathname only (no query string, no hash) so that
 * query-param variation on the same logical page doesn't fragment the cache.
 */
export function serializeCandidateForEmbedding(candidate: CandidateNode, urlPath?: string): string {
  const name = candidate.name?.trim() || candidate.textContent?.trim() || '';
  const base = name ? `${candidate.role}: ${name}` : candidate.role;
  return urlPath ? `${base} @ ${urlPath}` : base;
}

/**
 * Returns the single candidate whose visible text/role best word-overlaps the
 * target description. Used for element_embedding L2.5 lookup to pick which
 * candidate's semantic identity to search the cache with.
 */
function pickTopCandidate(candidates: CandidateNode[], target: string): CandidateNode {
  const words = target.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return candidates[0];

  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const haystack = `${c.role} ${c.name ?? ''} ${c.textContent ?? ''}`.toLowerCase();
    const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

const ELEMENT_EMBEDDING_THRESHOLD = 0.95;

function toCompactCandidates(candidates: CandidateNode[]): CompactCandidate[] {
  return candidates.map((c) => ({
    kaizenId: c.kaizenId ?? '',
    role: c.role,
    name: c.name?.trim() || c.textContent?.trim() || '',
    selector: c.cssSelector,
  }));
}

interface PlaywrightPageLike {
  $(selector: string): Promise<unknown | null>;
  $$(selector: string): Promise<unknown[]>;
  locator?(selector: string): {
    count(): Promise<number>;
    ariaSnapshot?(): Promise<string>;
    first(): {
      evaluate<T>(fn: (el: Element) => T): Promise<T>;
      ariaSnapshot?(): Promise<string>;
    };
  };
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
    private readonly sharedPool?: ISharedPoolService,
    private readonly redis?: Redis,
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> {
    const span = this.observability.startSpan('resolver.resolve', { tenantId: context.tenantId });
    try {
      if (!step.targetDescription) {
        this.observability.log('info', 'resolver.early_exit', {
          reason: 'no target description',
          action: step.action,
        });
        return { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
      }

      const rawCandidates = await this.domPruner.prune(context.page, step.targetDescription);

      if (rawCandidates.length === 0) {
        this.observability.log('warn', 'resolver.no_candidates', { action: step.action });
        return { selectors: [], fromCache: false, cacheSource: null, resolutionSource: null, similarityScore: null };
      }

      // Filter to roles that are structurally compatible with the action
      // (e.g. a `type` action must target a textbox/searchbox/combobox, never a link).
      // Falls back to the full list if no compatible candidate is found, so custom
      // widgets without standard ARIA roles are not silently discarded.
      const candidates = filterCandidatesByAction(rawCandidates, step.action);

      if (candidates !== rawCandidates) {
        this.observability.log('info', 'resolver.action_role_filter', {
          action: step.action,
          before: rawCandidates.length,
          after: candidates.length,
        });
      }

      const page = context.page as unknown as PlaywrightPageLike;

      // ── L2.5: element_embedding similarity search ─────────────────────────
      // Embed the top word-overlap candidate's semantic identity (role + name)
      // and search the cache's element_embedding column. This catches cases like
      // "type 'hello' in username" and "type 'test' in username" — same element,
      // different value, different targetHash — without an LLM call.
      const topCandidate = pickTopCandidate(candidates, step.targetDescription);
      const elementHit = await this.elementEmbeddingLookup(topCandidate, context.tenantId, context.domain, context.pageUrl);
      if (elementHit) {
        const validFromCache = await this.validateSelectors(elementHit.selectors, page);
        if (validFromCache.length > 0) {
          this.observability.increment('resolver.cache_hit', { source: 'element_embedding' });
          return { selectors: validFromCache, fromCache: true, cacheSource: 'tenant', resolutionSource: 'pgvector_element', similarityScore: elementHit.similarity, candidates: toCompactCandidates(candidates) };
        }
      }

      // ── L5: LLM resolution ────────────────────────────────────────────────
      const llmResult = await this.llmGateway.resolveElement(step, candidates, context.tenantId);

      // Discard any selector the LLM hallucinated or that no longer resolves.
      let validSelectors = await this.validateSelectors(llmResult.selectors, page, true);

      // Diagnostic: when every LLM selector fails validation we end up using kz-id
      // (session-only, never cached). Capture pruner-vs-Playwright ground truth so
      // we can fix the pruner or the validation logic instead of silently paying
      // LLM tokens every run.
      if (validSelectors.length === 0 && llmResult.selectors.length > 0) {
        const attempted = await Promise.all(
          llmResult.selectors.map(async (s) => {
            let locatorCount: number | null = null;
            try {
              locatorCount = (await page.locator?.(s.selector).count()) ?? null;
            } catch { /* ignore — locator may throw on malformed selectors */ }
            return { selector: s.selector, strategy: s.strategy, locatorCount };
          }),
        );

        let prunerCandidate: { role?: string; name?: string } | null = null;
        const pickedId = llmResult.llmPickedKaizenId ?? null;
        const probes: Record<string, unknown> = {};
        if (pickedId) {
          const picked = candidates.find((c) => c.kaizenId === pickedId);
          prunerCandidate = picked ? { role: picked.role, name: picked.name } : null;

          if (picked) {
            const name = picked.name;
            const role = picked.role;

            // Ask Playwright's ARIA engine — this is the authoritative source of truth,
            // not the pruner's in-page DOM traversal. If these differ, the pruner is the bug.
            const tryCount = async (selector: string): Promise<number | 'err'> => {
              try { return (await page.locator?.(selector).count()) ?? 0; } catch { return 'err'; }
            };
            probes.exact = await tryCount(`role=${role}[name="${name}"]`);
            probes.singleQuote = await tryCount(`role=${role}[name='${name}']`);
            probes.caseInsensitive = await tryCount(`role=${role}[name="${name}" i]`);
            // Regex match — strips the AX engine's potential whitespace normalization
            const nameEscaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            probes.regex = await tryCount(`role=${role}[name=/${nameEscaped}/]`);
            probes.roleOnly = await tryCount(`role=${role}`);

            // Ask Playwright directly what it thinks this element's accessible name is.
            // Output form: `- role "Accessible Name":\n  - /url: ...`
            try {
              const snap = await page.locator?.(`[data-kaizen-id='${pickedId}']`).first().ariaSnapshot?.();
              probes.ariaSnapshot = snap ?? null;
            } catch (e: any) { probes.ariaSnapshot = { error: e.message }; }

            // Dump the kz-id element's attributes + aria context so we can see WHY
            // Playwright's AX computation would differ from what the pruner stored.
            try {
              probes.element = await page.locator?.(`[data-kaizen-id='${pickedId}']`).first().evaluate((el) => {
                const attrs: Record<string, string> = {};
                const attrMap = (el as Element).attributes;
                for (let i = 0; i < attrMap.length; i++) {
                  const a = attrMap.item(i);
                  if (a) attrs[a.name] = a.value;
                }
                return {
                  tag: (el as Element).tagName.toLowerCase(),
                  attrs,
                  innerText: ((el as HTMLElement).innerText ?? '').slice(0, 200),
                  textContent: ((el as Element).textContent ?? '').slice(0, 200),
                  ariaHidden: (el as Element).closest('[aria-hidden="true"]') !== null,
                  hiddenByCss: (() => {
                    const s = window.getComputedStyle(el as Element);
                    return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0';
                  })(),
                };
              }) ?? null;
            } catch (e: any) { probes.element = { error: e.message }; }
          }
        }

        this.observability.log('warn', 'resolver.all_selectors_invalidated', {
          pickedKaizenId: pickedId,
          attempted,
          prunerCandidate,
          probes,
          pageUrl: context.pageUrl ?? null,
        });
      }

      // Track whether the winning selector is session-scoped (data-kaizen-id)
      // and therefore must NOT be cached — it won't exist in the next session.
      let sessionOnly = false;

      // When a stable selector is ambiguous we swap to kz-id for execution but
      // still want to cache a stable selector so future runs don't re-invoke the LLM.
      // This variable holds the selectors to persist; defaults to validSelectors below.
      let cacheSelectors: typeof validSelectors | null = null;
      // Set to true when we deliberately decline to cache (ambiguous selector with no
      // unique stable alternative). Distinct from `cacheSelectors === null`, which
      // means "fall back to selectorSet". See spec-element-resolver-ambiguous-cache-write.md.
      let skipCacheWrite = false;

      // ── Ambiguity check ───────────────────────────────────────────────────
      // If the top stable selector matches more than one element (e.g. two inputs
      // share role=textbox[name="Email Address"]), Playwright picks DOM-first which
      // may be the wrong element even though the LLM picked the correct candidate.
      // In that case, swap to the session-scoped data-kaizen-id selector — it is
      // always unique because we injected it ourselves into the live DOM.
      if (validSelectors.length > 0 && llmResult.llmPickedKaizenId) {
        const isUnique = await this.isSelectorUnique(validSelectors[0].selector, page);
        if (!isUnique) {
          const kzSelector = `[data-kaizen-id='${llmResult.llmPickedKaizenId}']`;
          try {
            const handle = await page.$(kzSelector);
            if (handle !== null) {
              this.observability.increment('resolver.ambiguous_selector_kz_fallback');

              // Try to find a unique stable selector for this element among the
              // candidate's pre-generated selectorCandidates. The ambiguous top
              // selector itself must never be cached — Playwright would resolve
              // it DOM-first on the next run and target the wrong element.
              const pickedCandidate = candidates.find((c) => c.kaizenId === llmResult.llmPickedKaizenId);
              const uniqueStable = pickedCandidate
                ? await this.firstUniqueStableSelector(pickedCandidate, page)
                : null;

              if (uniqueStable) {
                cacheSelectors = [uniqueStable];
                this.observability.increment('resolver.ambiguous_selector_disambiguated');
              } else {
                skipCacheWrite = true;
                this.observability.increment('resolver.ambiguous_selector_uncacheable');
              }

              validSelectors = [{ selector: kzSelector, strategy: 'css' as const, confidence: 1.0 }];
            }
          } catch { /* keep the ambiguous stable selector — better than nothing */ }
        }
      }

      // ── LLM-picked candidate: data-kaizen-id fallback ─────────────────────
      // The LLM correctly identified the element but the pre-generated selectors
      // failed validation (e.g. Playwright's AX tree computes a slightly different
      // accessible name than our DOM pruner). Since data-kaizen-id was injected
      // in THIS session, use it for execution but never cache it.
      if (validSelectors.length === 0 && llmResult.llmPickedKaizenId) {
        const kzSelector = `[data-kaizen-id='${llmResult.llmPickedKaizenId}']`;
        try {
          const handle = await page.$(kzSelector);
          if (handle !== null) {
            validSelectors = [{ selector: kzSelector, strategy: 'css' as const, confidence: 0.50 }];
            sessionOnly = true;
            this.observability.increment('resolver.kaizen_id_fallback_used');
          }
        } catch { /* fall through */ }
      }

      // ── Pre-generated selector fallback ──────────────────────────────────
      // If the LLM returned no valid selectors (e.g. all hallucinated), walk the
      // DOM-pruner-generated selectorCandidates for each candidate in order.
      if (validSelectors.length === 0) {
        this.observability.increment('resolver.llm_output_unusable');
        const seen = new Set<string>();
        for (const candidate of candidates) {
          for (const sel of (candidate.selectorCandidates ?? [])) {
            if (seen.has(sel.selector)) continue;
            seen.add(sel.selector);
            try {
              const handle = await page.$(sel.selector);
              if (handle !== null) {
                validSelectors = [sel];
                break;
              }
            } catch {
              // keep trying
            }
          }
          if (validSelectors.length > 0) break;
        }
        if (validSelectors.length > 0) {
          this.observability.increment('resolver.fallback_selector_used');
        }
      }

      const selectorSet: SelectorSet = {
        selectors: validSelectors,
        fromCache: false,
        cacheSource: null,
        resolutionSource: 'llm',
        similarityScore: null,
        // Use the exact ranked list the LLM was shown, not the full pruner output
        candidates: llmResult.llmPromptedCandidates ?? toCompactCandidates(candidates),
        llmPickedKaizenId: llmResult.llmPickedKaizenId ?? null,
        tokensUsed: (llmResult.promptTokens ?? 0) + (llmResult.completionTokens ?? 0),
      };

      // Only cache stable selectors — session-scoped data-kaizen-id must never be persisted.
      // When cacheSelectors is set the execution used kz-id but we persist a unique
      // stable selector. When skipCacheWrite is true we deliberately write nothing;
      // a future run will pay for one more LLM call but will not be poisoned by an
      // ambiguous cache hit.
      if (!sessionOnly && !skipCacheWrite) {
        const setToCache = cacheSelectors
          ? { ...selectorSet, selectors: cacheSelectors }
          : selectorSet;
        if (setToCache.selectors.length > 0) {
          void this.persistToCache(step, context, setToCache, candidates);
        }
      }

      return selectorSet;
    } finally {
      span.end();
    }
  }

  async recordSuccess(targetHash: string, domain: string, selectorUsed: string): Promise<void> {
    this.observability.increment('resolver.record_success', { domain });
    await this.updateOutcomeWindow(targetHash, domain, true, selectorUsed);
  }

  async recordFailure(targetHash: string, domain: string, selectorAttempted: string): Promise<void> {
    this.observability.increment('resolver.record_failure', { domain });
    await this.updateOutcomeWindow(targetHash, domain, false, selectorAttempted);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * L2.5: search selector_cache by element_embedding cosine similarity.
   * Embeds the candidate's stable semantic identity (role + accessible name + URL path)
   * and finds the nearest stored element. Returns null on miss or DB error.
   *
   * The URL path is included in the embedding text so that elements with the same
   * role+name on different pages (e.g. "textbox: Email" on /login vs /register)
   * produce distinct vectors and cannot false-positive match each other.
   */
  private async elementEmbeddingLookup(
    candidate: CandidateNode,
    tenantId: string,
    domain: string,
    pageUrl?: string,
  ): Promise<{ selectors: SelectorEntry[]; similarity: number } | null> {
    try {
      const urlPath = pageUrl ? new URL(pageUrl).pathname : undefined;
      const text = serializeCandidateForEmbedding(candidate, urlPath);
      const embedding = await this.llmGateway.generateEmbedding(text);
      const embeddingSQL = toVectorSQL(embedding);

      const { rows } = await getPool().query<{ selectors: SelectorEntry[]; similarity: number }>(
        `SELECT selectors,
                1 - (element_embedding <=> $1::vector) AS similarity
         FROM selector_cache
         WHERE element_embedding IS NOT NULL
           AND domain = $2
           AND tenant_id = $3
           AND confidence_score > 0.4
           AND 1 - (element_embedding <=> $1::vector) > $4
         ORDER BY element_embedding <=> $1::vector
         LIMIT 1`,
        [embeddingSQL, domain, tenantId, ELEMENT_EMBEDDING_THRESHOLD],
      );

      return rows.length > 0 ? { selectors: rows[0].selectors, similarity: rows[0].similarity } : null;
    } catch (e: any) {
      this.observability.log('warn', 'resolver.element_embedding_lookup_failed', { error: e.message });
      return null;
    }
  }

  /**
   * Returns true if the selector matches exactly one element on the page.
   * A selector that matches multiple elements is ambiguous — using it would
   * target the first DOM occurrence, which may not be the intended element.
   */
  private async isSelectorUnique(selector: string, page: PlaywrightPageLike): Promise<boolean> {
    try {
      const handles = await page.$$(selector);
      return handles.length <= 1;
    } catch {
      return true; // assume unique on error so we don't needlessly fall back
    }
  }

  /**
   * Walk the candidate's pre-generated selectorCandidates (stable → least stable)
   * and return the first one that resolves to exactly one element on the page.
   *
   * Used when the LLM-picked element's top stable selector is ambiguous: the
   * ambiguous selector must not be cached (Playwright would target the wrong
   * element next run), but a less-preferred selector may still uniquely identify
   * the same element. Skips data-kaizen-id selectors — those are session-scoped
   * and never cacheable.
   */
  private async firstUniqueStableSelector(
    candidate: CandidateNode,
    page: PlaywrightPageLike,
  ): Promise<SelectorEntry | null> {
    for (const sel of candidate.selectorCandidates ?? []) {
      if (sel.selector.includes('data-kaizen-id')) continue;
      try {
        const handles = await page.$$(sel.selector);
        if (handles.length === 1) return sel;
      } catch {
        // selector malformed or otherwise unparseable; try the next one
      }
    }
    return null;
  }

  /**
   * Validate selectors against the live DOM and return only those that resolve.
   * When trackMetrics is true, increments observability counters per-miss.
   */
  private async validateSelectors(
    selectors: SelectorEntry[],
    page: PlaywrightPageLike,
    trackMetrics = false,
  ): Promise<SelectorEntry[]> {
    const valid: SelectorEntry[] = [];
    for (const sel of selectors) {
      try {
        const handle = await page.$(sel.selector);
        if (handle !== null) {
          valid.push(sel);
        } else if (trackMetrics) {
          this.observability.increment('resolver.validation_failed', { strategy: sel.strategy });
        }
      } catch {
        if (trackMetrics) {
          this.observability.increment('resolver.validation_error', { strategy: sel.strategy });
        }
      }
    }
    return valid;
  }

  private async persistToCache(
    step: StepAST,
    context: ResolutionContext,
    selectorSet: SelectorSet,
    candidates: CandidateNode[],
  ): Promise<void> {
    try {
      const winningSelector = selectorSet.selectors[0].selector;

      const winningCandidate =
        candidates.find(
          (c) => c.cssSelector === winningSelector || c.xpath === winningSelector,
        ) ?? candidates[0];

      // Run both embedding calls in parallel — they are fully independent.
      // Element embedding includes the URL pathname so same-name elements on different
      // pages produce distinct vectors (see serializeCandidateForEmbedding for rationale).
      const urlPath = context.pageUrl ? new URL(context.pageUrl).pathname : undefined;
      const [stepEmbedding, elementEmbedding] = await Promise.all([
        this.llmGateway.generateEmbedding(`${step.action} ${step.targetDescription ?? ''}`),
        this.llmGateway.generateEmbedding(serializeCandidateForEmbedding(winningCandidate, urlPath)),
      ]);

      // Store under targetHash so every step targeting this element hits the same row.
      // Single retry on transient DB errors — the LLM call that produced this result
      // cost tokens, so losing it to a connection blip means paying again next run.
      await this.writeCacheRow(context, step, selectorSet, stepEmbedding, elementEmbedding);

      this.observability.increment('resolver.cache_write', { domain: context.domain });

      // Contribute to shared pool (fire-and-forget) — skips if tenant not opted in or quality < 0.8
      if (this.sharedPool) {
        void this.sharedPool.contribute({
          tenantId: context.tenantId,
          contentHash: step.targetHash,
          domain: context.domain,
          selectors: selectorSet.selectors,
          stepEmbedding,
          elementEmbedding,
          confidenceScore: 1.0,
        });
      }
    } catch (e: any) {
      this.observability.log('warn', 'resolver.cache_write_failed', { error: e.message });
    }
  }

  private async writeCacheRow(
    context: ResolutionContext,
    step: StepAST,
    selectorSet: SelectorSet,
    stepEmbedding: number[],
    elementEmbedding: number[],
  ): Promise<void> {
    const sql = `INSERT INTO selector_cache
           (tenant_id, content_hash, domain, selectors, step_embedding, element_embedding)
         VALUES ($1, $2, $3, $4, $5::vector, $6::vector)
         ON CONFLICT (tenant_id, content_hash, domain)
         DO UPDATE SET
           selectors         = EXCLUDED.selectors,
           step_embedding    = EXCLUDED.step_embedding,
           element_embedding = EXCLUDED.element_embedding,
           updated_at        = now()
         WHERE selector_cache.pinned_at IS NULL`;
    const params = [
      context.tenantId,
      step.targetHash,
      context.domain,
      JSON.stringify(selectorSet.selectors),
      toVectorSQL(stepEmbedding),
      toVectorSQL(elementEmbedding),
    ];

    try {
      await getPool().query(sql, params);
    } catch (firstError: any) {
      if (isTransient(firstError)) {
        this.observability.increment('resolver.cache_write_retry');
        await new Promise((r) => setTimeout(r, 100));
        await getPool().query(sql, params);
      } else {
        throw firstError;
      }
    }
  }

  private async updateOutcomeWindow(
    targetHash: string,
    domain: string,
    success: boolean,
    _selector: string,
  ): Promise<void> {
    try {
      const pool = getPool();

      const { rows } = await pool.query<{ outcome_window: boolean[] }>(
        `SELECT outcome_window FROM selector_cache
         WHERE content_hash = $1 AND domain = $2
         LIMIT 1`,
        [targetHash, domain],
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
        [JSON.stringify(newWindow), newScore, success, targetHash, domain],
      );

      // Invalidate Redis so the next resolve reads fresh data from Postgres
      // instead of serving a stale cached entry for up to 1 hour.
      if (this.redis) {
        const evicted = await invalidateRedisCache(this.redis, targetHash, domain);
        if (evicted > 0) {
          this.observability.increment('resolver.redis_invalidated', { count: String(evicted) });
        }
      }
    } catch (e: any) {
      this.observability.log('warn', 'resolver.outcome_update_failed', { error: e.message });
    }
  }
}
