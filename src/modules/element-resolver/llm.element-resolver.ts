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
import { canonicalFrameUrl, findFrameByUrl, framesOf } from '../../utils/frame-url';

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

// When a step NAMES the kind of control it targets ("the College radio button", "the
// second checkbox"), the resolved element's role must be compatible with that kind.
// This guards the element-embedding SHORTCUT: it can return a cached selector for a
// semantically-near-but-wrong element (a Sex checkbox for "College radio button"),
// silently bypassing the LLM that would get it right. Ordered so "radio button" maps to
// radio, not button. Targets that name no control kind → null → no guard (unchanged).
const ROLE_KEYWORDS: Array<{ re: RegExp; roles: string[] }> = [
  { re: /\bradio(\s*-?\s*button)?s?\b/, roles: ['radio'] },
  { re: /\bcheck\s*-?\s*boxe?s?\b/, roles: ['checkbox'] },
  { re: /\b(drop\s*-?\s*down|combobox|listbox)\b/, roles: ['combobox', 'listbox'] },
  { re: /\b(text\s*-?\s*box|text\s*area|input|field)\b/, roles: ['textbox', 'searchbox', 'combobox', 'spinbutton'] },
  { re: /\blinks?\b/, roles: ['link'] },
  { re: /\btabs?\b/, roles: ['tab'] },
  { re: /\boptions?\b/, roles: ['option'] },
  { re: /\bbuttons?\b/, roles: ['button'] },
];
export function targetImpliedRoles(target: string): string[] | null {
  const t = (target || '').toLowerCase();
  for (const { re, roles } of ROLE_KEYWORDS) if (re.test(t)) return roles;
  return null;
}

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
 * Minimal surface of a Playwright Frame used when resolving inside a child iframe.
 * A Frame implements the same element API as a Page, so it satisfies the subset of
 * PlaywrightPageLike that selector synthesis and uniqueness checks need.
 */
type FrameContext = {
  url?: () => string;
  locator?: (s: string) => { count: () => Promise<number> };
};

/**
 * Spec ref: Section 6.3 — LLMElementResolver
 *
 * Phase 2 additions over Phase 1:
 *  - Persists resolved selectors to selector_cache (Postgres)
 *  - Generates and stores step_embedding after every LLM resolution
 *  - recordSuccess / recordFailure update outcome_window and recompute confidence_score
 */
export class LLMElementResolver implements IElementResolver {
  private readonly cacheReads: boolean;
  private readonly cacheWrites: boolean;
  constructor(
    private readonly domPruner: IDOMPruner,
    private readonly llmGateway: ILLMGateway,
    private readonly observability: IObservability,
    private readonly sharedPool?: ISharedPoolService,
    private readonly redis?: Redis,
    // State/negative assertions verify the CURRENT page and must resolve FRESH: they must
    // not READ the cross-run element_embedding cache (a prior — possibly wrong — resolution
    // of the same phrase can return a confident but WRONG element, e.g. "College radio
    // button" hitting a cached checkbox at similarity 1) nor WRITE back into it. The
    // interaction resolver keeps both on (its whole value is learning across runs).
    options?: { cacheReads?: boolean; cacheWrites?: boolean },
  ) {
    this.cacheReads = options?.cacheReads ?? true;
    this.cacheWrites = options?.cacheWrites ?? true;
  }

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
      // Skip the cross-run element cache entirely for no-cache-read resolvers (assertions):
      // fresh DOM candidates + LLM only, so a poisoned prior embedding can't hijack a verify.
      const elementHit = this.cacheReads
        ? await this.elementEmbeddingLookup(topCandidate, context.tenantId, context.domain, context.pageUrl)
        : null;
      if (elementHit) {
        const validFromCache = await this.validateSelectors(elementHit.selectors, page);
        if (validFromCache.length > 0) {
          // Role guard: if the step named a control kind, the cached element must BE that
          // kind. Rejecting a role-mismatched shortcut (a checkbox for "radio button")
          // falls through to the LLM, which sees every candidate and resolves correctly.
          const wantRoles = targetImpliedRoles(step.targetDescription);
          const gotRole = wantRoles ? await this.coarseRole(validFromCache[0].selector, page) : null;
          if (wantRoles && gotRole && !wantRoles.includes(gotRole)) {
            this.observability.log('info', 'resolver.cache_role_mismatch', { want: wantRoles, got: gotRole, selector: validFromCache[0].selector });
          } else {
            this.observability.increment('resolver.cache_hit', { source: 'element_embedding' });
            return { selectors: validFromCache, fromCache: true, cacheSource: 'tenant', resolutionSource: 'pgvector_element', similarityScore: elementHit.similarity, candidates: toCompactCandidates(candidates) };
          }
        }
      }

      // ── L5: LLM resolution ────────────────────────────────────────────────
      const llmResult = await this.llmGateway.resolveElement(step, candidates, context.tenantId);

      // ── Frame candidate short-circuit ─────────────────────────────────────
      // If the LLM picked an element INSIDE a child frame (e.g. a cookie-consent CMP
      // iframe), its selectors resolve within that frame, not the page — the page-coupled
      // validation below would find 0 matches and discard it. Validate in-frame and return
      // a frame-scoped, session-only set (frame elements are never cached).
      const pickedFrameCand = llmResult.llmPickedKaizenId
        ? candidates.find((c) => c.kaizenId === llmResult.llmPickedKaizenId && c.frameUrl)
        : undefined;
      if (pickedFrameCand?.frameUrl) {
        const frameSet = await this.resolveInFrame(pickedFrameCand, llmResult, candidates, context, step);
        if (frameSet) return frameSet;
      }

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
                // No pre-generated selector is unique — the Class-A blind spot:
                // a contextual / repeated / unlabeled control with no id/testid, whose
                // only unique handle was the transient data-kaizen-id (never cacheable →
                // re-invokes the LLM every run). Synthesize a unique STRUCTURAL selector
                // from the picked element so it caches and warm runs resolve at zero tokens.
                const synthesized = await this.synthesizeUniqueSelector(page, kzSelector);
                if (synthesized) {
                  cacheSelectors = [synthesized];
                  this.observability.increment('resolver.synthesized_scoped_selector');
                } else {
                  skipCacheWrite = true;
                  this.observability.increment('resolver.ambiguous_selector_uncacheable');
                }
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
        /* A prompt-cache hit replays a previous answer: no request is sent and the
           billing meter emits nothing. The cached payload still carries the ORIGINAL
           call's token counts, so copying them here charged the run for a call it never
           made — step_results totalled 388 tokens against 181 actually billed, and a
           repeat run showed "AI · 97 tok" while costing nothing. */
        tokensUsed: llmResult.fromCache ? 0 : (llmResult.promptTokens ?? 0) + (llmResult.completionTokens ?? 0),
      };

      // Last-resort synthesis: if the only usable selector is the transient data-kaizen-id
      // (an unlabeled / attribute-less control — e.g. an unlabelled <input type=number>, or
      // one of several identical checkboxes — with no pre-generated stable selector), build
      // a unique STRUCTURAL selector from the picked element so it CACHES instead of
      // re-invoking the LLM every run. Execution still uses kz this run; the cache stores
      // the replayable structural selector for the next.
      if (this.cacheWrites && !skipCacheWrite && !cacheSelectors && llmResult.llmPickedKaizenId) {
        const only = validSelectors[0]?.selector ?? '';
        if (sessionOnly || only.includes('data-kaizen-id')) {
          const synthesized = await this.synthesizeUniqueSelector(page, `[data-kaizen-id='${llmResult.llmPickedKaizenId}']`);
          if (synthesized) {
            cacheSelectors = [synthesized];
            sessionOnly = false;
            this.observability.increment('resolver.synthesized_scoped_selector');
          }
        }
      }

      // Only cache stable selectors — session-scoped data-kaizen-id must never be persisted.
      // When cacheSelectors is set the execution used kz-id but we persist a unique
      // stable selector. When skipCacheWrite is true we deliberately write nothing;
      // a future run will pay for one more LLM call but will not be poisoned by an
      // ambiguous cache hit.
      if (this.cacheWrites && !sessionOnly && !skipCacheWrite) {
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
   * Coarse ARIA-ish role of the element a selector resolves to — used to reject an
   * element-embedding cache hit whose kind contradicts the step's named control.
   * Returns null on any error (→ caller does not reject, i.e. fail-open).
   */
  private async coarseRole(selector: string, page: PlaywrightPageLike): Promise<string | null> {
    try {
      const loc = page.locator?.(selector);
      if (!loc) return null;
      return (await loc.first().evaluate((el) => {
        const e = el as HTMLElement;
        const explicit = e.getAttribute('role');
        if (explicit) return explicit;
        const tag = e.tagName.toLowerCase();
        if (tag === 'a' && e.hasAttribute('href')) return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
          const type = (e.getAttribute('type') || 'text').toLowerCase();
          if (type === 'radio') return 'radio';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
          if (type === 'number') return 'spinbutton';
          return 'textbox';
        }
        return null;
      })) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve an LLM-picked element that lives inside a child FRAME (e.g. a cookie-consent
   * CMP iframe). Validates the candidate's selectors WITHIN that frame (not the page) and
   * returns a frame-scoped SelectorSet the engine acts on via the frame.
   * Returns null if the frame is gone or no selector resolves inside it.
   *
   * This path used to return without ever writing to `selector_cache`, so a consent
   * banner re-paid the model on every run, forever — the last permanent floor under the
   * cost curve after B19. The blocker was real but narrower than the conclusion drawn
   * from it: a CMP iframe's URL carries per-session tokens, so it cannot be stored
   * verbatim. The element inside it is as stable as any other. We store the frame's
   * canonical identity (origin + pathname) instead, and cache the element normally.
   * Spec: docs/specs/reliability/spec-iframe-selector-caching.md
   */
  private async resolveInFrame(
    cand: CandidateNode,
    // fromCache: a prompt-cache replay costs nothing, so the frame path must zero the
    // tokens too — otherwise the same over-count reappears for iframe-resolved elements.
    llmResult: { selectors?: SelectorEntry[]; llmPickedKaizenId?: string | null; promptTokens?: number; completionTokens?: number; llmPromptedCandidates?: CompactCandidate[]; fromCache?: boolean },
    candidates: CandidateNode[],
    context: ResolutionContext,
    step: StepAST,
  ): Promise<SelectorSet | null> {
    try {
      const frames = framesOf<FrameContext>(context.page);
      const frame = cand.frameUrl ? findFrameByUrl(frames, cand.frameUrl) : null;
      if (!frame || !frame.locator) return null;

      const kzSelector = cand.kaizenId ? `[data-kaizen-id='${cand.kaizenId}']` : null;
      const kz: SelectorEntry[] = kzSelector
        ? [{ selector: kzSelector, strategy: 'css', confidence: 0.5 }]
        : [];
      const tryList: SelectorEntry[] = [...(llmResult.selectors ?? []), ...(cand.selectorCandidates ?? []), ...kz];

      const countIn = async (selector: string): Promise<number> => {
        try {
          return await frame.locator!(selector).count();
        } catch {
          return 0;  // malformed in-frame selector — treat as no match
        }
      };

      // Execution selector: the first that resolves at all, exactly as before.
      // Cache selector: the first STABLE one that resolves UNIQUELY. A selector matching
      // two elements must never be cached — Playwright would take the DOM-first one next
      // run and act on the wrong element. Same rule the main-document path applies.
      let executed: SelectorEntry | null = null;
      let cacheable: SelectorEntry | null = null;

      for (const s of tryList) {
        const count = await countIn(s.selector);
        if (count < 1) continue;
        executed ??= s;
        if (!cacheable && count === 1 && !s.selector.includes('data-kaizen-id')) {
          cacheable = s;
        }
        if (executed && cacheable) break;
      }

      if (!executed) return null;
      this.observability.increment('resolver.frame_resolved');

      // Nothing stable and unique inside the frame — the same blind spot B19 hit on the
      // page: an unlabelled control whose only handle was the transient data-kaizen-id.
      // Synthesize a structural selector from within the frame so it caches. A Playwright
      // Frame exposes locator()/$$ and its documents resolve against the frame, so the
      // page implementation works here unchanged.
      if (!cacheable && this.cacheWrites && kzSelector) {
        const synthesized = await this.synthesizeUniqueSelector(frame as unknown as PlaywrightPageLike, kzSelector);
        if (synthesized) {
          cacheable = synthesized;
          this.observability.increment('resolver.frame_synthesized_selector');
        }
      }

      const liveFrameUrl = typeof frame.url === 'function' ? frame.url() : cand.frameUrl;
      const selectorSet: SelectorSet = {
        selectors: [executed],
        fromCache: false,
        cacheSource: null,
        resolutionSource: 'llm',
        similarityScore: null,
        candidates: llmResult.llmPromptedCandidates ?? toCompactCandidates(candidates),
        llmPickedKaizenId: cand.kaizenId ?? null,
        // The live URL, session tokens and all: the engine matches it exactly this run.
        // The cache gets the canonical form below, which is what survives to the next.
        frameUrl: liveFrameUrl,
        tokensUsed: llmResult.fromCache ? 0 : (llmResult.promptTokens ?? 0) + (llmResult.completionTokens ?? 0),
      };

      // A frame with no durable identity (about:blank, srcdoc, data:) cannot be found
      // again next run, so an entry pointing at it would only ever miss. Keep those
      // session-only rather than write a row that can never hit.
      const canonical = canonicalFrameUrl(liveFrameUrl);
      if (this.cacheWrites && cacheable && canonical) {
        void this.persistToCache(
          step,
          context,
          { ...selectorSet, selectors: [cacheable], frameUrl: canonical },
          // Pass the picked frame candidate so the element embedding describes the element
          // we actually resolved; persistToCache falls back to candidates[0], which here
          // would otherwise be an unrelated main-document node.
          [cand],
        );
      } else if (this.cacheWrites && !cacheable) {
        this.observability.increment('resolver.frame_uncacheable');
      }

      return selectorSet;
    } catch {
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
   * Synthesize a UNIQUE, stable, cacheable CSS selector for the element located by
   * `anchorSelector` (the session-scoped data-kaizen-id), used when none of the
   * pre-generated selectorCandidates is unique — the Class-A blind spot: repeated /
   * contextually-disambiguated / unlabeled controls with no id/testid.
   *
   * Walks up from the element building a minimal `tag:nth-of-type(n)` path anchored on
   * the nearest ancestor id, stopping as soon as the path is unique. Unlike the transient
   * data-kaizen-id (which does not exist on a fresh page load), this structural selector
   * is REPLAYABLE, so it can be cached — turning a step that re-invoked the LLM every run
   * into a zero-token warm resolve. Warm runs execute it live and re-verify, so a drifted
   * path fails and heals rather than false-passing.
   *
   * No named inner functions in the browser closure (tsx/esbuild keepNames would wrap them
   * with __name and break serialization in pages without the worker's shim).
   */
  private async synthesizeUniqueSelector(
    page: PlaywrightPageLike,
    anchorSelector: string,
  ): Promise<SelectorEntry | null> {
    try {
      const sel = await page.locator?.(anchorSelector).first().evaluate((el) => {
        if (!(el instanceof Element)) return null;
        const doc = el.ownerDocument;
        const parts: string[] = [];
        let node: Element | null = el;
        let depth = 0;
        while (node && node.nodeType === 1 && node !== doc.documentElement && depth < 8) {
          depth++;
          if (node.id && doc.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
            parts.unshift(`#${CSS.escape(node.id)}`);
            break;
          }
          let seg = node.tagName.toLowerCase();
          const parent: Element | null = node.parentElement;
          if (parent) {
            const twins = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
            if (twins.length > 1) seg += `:nth-of-type(${twins.indexOf(node!) + 1})`;
          }
          parts.unshift(seg);
          if (doc.querySelectorAll(parts.join(' > ')).length === 1) break;
          node = node.parentElement;
        }
        const out = parts.join(' > ');
        return out && doc.querySelectorAll(out).length === 1 ? out : null;
      });
      if (typeof sel === 'string' && sel && (await this.isSelectorUnique(sel, page))) {
        return { selector: sel, strategy: 'css' as const, confidence: 0.85 };
      }
    } catch {
      /* synthesis failed — caller falls back to skipCacheWrite */
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

      // Contribute to shared pool (fire-and-forget) — skips if tenant not opted in or quality < 0.8.
      // Frame-scoped entries stay out: the shared pool is keyed on (content_hash, domain) with no
      // frame dimension, so a consent-banner selector would be handed to other tenants as if it
      // lived in the main document. Promoting them needs its own key, not a default.
      if (this.sharedPool && !selectorSet.frameUrl) {
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
    // frame_url is the canonical (origin + pathname) identity of the iframe the element
    // lives in, or NULL for the main document. It travels with the selectors because a
    // frame-scoped selector is meaningless — and, run against the top document, actively
    // harmful — without knowing where to run it.
    const sql = `INSERT INTO selector_cache
           (tenant_id, content_hash, domain, selectors, step_embedding, element_embedding, frame_url)
         VALUES ($1, $2, $3, $4, $5::vector, $6::vector, $7)
         ON CONFLICT (tenant_id, content_hash, domain)
         DO UPDATE SET
           selectors         = EXCLUDED.selectors,
           step_embedding    = EXCLUDED.step_embedding,
           element_embedding = EXCLUDED.element_embedding,
           frame_url         = EXCLUDED.frame_url,
           updated_at        = now()
         WHERE selector_cache.pinned_at IS NULL`;
    const params = [
      context.tenantId,
      step.targetHash,
      context.domain,
      JSON.stringify(selectorSet.selectors),
      toVectorSQL(stepEmbedding),
      toVectorSQL(elementEmbedding),
      selectorSet.frameUrl ?? null,
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

      // Invalidate Redis ONLY on failure. On failure the selector is now suspect
      // and confidence has dropped, so the next resolve must re-read Postgres (and
      // possibly miss + re-resolve). On SUCCESS the cached selector is confirmed
      // good and the Redis payload (selectors + embeddings) is unchanged — evicting
      // it here would wipe the L1 hot-cache entry that CachedElementResolver.writeRedis
      // just wrote on the same step, so L1 could never survive to serve a repeat run.
      if (!success && this.redis) {
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
