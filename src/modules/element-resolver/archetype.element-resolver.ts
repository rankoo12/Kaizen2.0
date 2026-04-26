/**
 * Spec ref: Smart Brain Layer 0 — Element Archetype Library
 *
 * Thin wrapper implementing IElementResolver that runs the archetype lookup
 * as L0 — before all cache layers (L1–L4) and before the LLM (L5).
 *
 * Resolution flow:
 *  1. Prune DOM candidates (same pruner as LLMElementResolver)
 *  2. Pick the top word-overlap candidate
 *  3. Match against the archetype library (IArchetypeResolver)
 *  4. On match: validate the ARIA selector against the live DOM
 *  5. On valid DOM hit: return SelectorSet with resolutionSource: 'archetype', tokensUsed: 0
 *  6. Otherwise: return empty SelectorSet so the chain falls through to L1
 */

import type { IElementResolver } from './interfaces';
import type { StepAST, SelectorSet, ResolutionContext, CandidateNode } from '../../types';
import type { IDOMPruner } from '../dom-pruner/interfaces';
import type { IObservability } from '../observability/interfaces';
import type { IArchetypeResolver } from './archetype.interfaces';

interface PlaywrightPageLike {
  $(selector: string): Promise<unknown>;
}

const MISS: SelectorSet = {
  selectors: [],
  fromCache: false,
  cacheSource: null,
  resolutionSource: null,
  similarityScore: null,
  tokensUsed: 0,
};

const TARGET_STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'into', 'for', 'of', 'with', 'and', 'or',
  'type', 'click', 'enter', 'press', 'select', 'choose', 'fill', 'input', 'tap',
  'field', 'button', 'link', 'box', 'textbox',
]);

/**
 * DOM-attribute tokens we fold into the ranking haystack alongside the
 * accessible name. These surface intent that the AX name may drop (e.g. when
 * the page labels a field "Email or Username" but the step says "username",
 * the <input name="username"> attribute still carries the signal).
 */
const RANK_ATTRIBUTES = ['id', 'name', 'placeholder', 'aria-label', 'data-testid'];

function extractTargetWords(target: string): string[] {
  return target
    .toLowerCase()
    .split(/[\s,.\-_/]+/)
    .filter((w) => w.length > 2 && !TARGET_STOPWORDS.has(w));
}

function candidateHaystack(c: CandidateNode): string {
  const attrBag = RANK_ATTRIBUTES.map((k) => c.attributes?.[k] ?? '')
    .filter(Boolean)
    .join(' ');
  return `${c.role} ${c.name ?? ''} ${c.textContent ?? ''} ${attrBag} ${c.parentContext ?? ''}`.toLowerCase();
}

function scoreCandidate(c: CandidateNode, words: string[]): number {
  if (words.length === 0) return 0;
  const hay = candidateHaystack(c);
  return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
}

type RankedCandidate = { candidate: CandidateNode; score: number };

/**
 * Ranks candidates by word-overlap with the target description.
 *
 * Haystack folds in DOM-attribute values (id/name/placeholder/aria-label/
 * data-testid) and the parent-context label so that cases where the AX name
 * differs from the step description but the attribute name agrees still rank
 * correctly (e.g. step "username" matches `<input name="username">` even when
 * the accessible name is "Email").
 *
 * Tiebreaker: shorter accessible name wins — "Sign in" is more specific
 * than "Sign in with a passkey" for the same overlap score.
 */
function rankCandidates(candidates: CandidateNode[], target: string): RankedCandidate[] {
  const words = extractTargetWords(target);
  return [...candidates]
    .map<RankedCandidate>((c) => ({ candidate: c, score: scoreCandidate(c, words) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const nameA = a.candidate.name || a.candidate.textContent;
      const nameB = b.candidate.name || b.candidate.textContent;
      return nameA.length - nameB.length;
    });
}

export class ArchetypeElementResolver implements IElementResolver {
  constructor(
    private readonly domPruner: IDOMPruner,
    private readonly archetypeResolver: IArchetypeResolver,
    private readonly observability: IObservability,
  ) {}

  async resolve(step: StepAST, context: ResolutionContext): Promise<SelectorSet> {
    // Archetypes only apply to steps that target a DOM element
    if (!step.targetDescription) return MISS;

    let candidates: CandidateNode[];
    try {
      candidates = await this.domPruner.prune(context.page, step.targetDescription);
    } catch (e: any) {
      this.observability.log('warn', 'archetype_resolver.prune_failed', { error: e.message });
      return MISS;
    }

    if (candidates.length === 0) {
      this.observability.increment('resolver.archetype_miss');
      return MISS;
    }

    // Fetch cooldown set before iterating — a single DB read for the target.
    const cooldown = await this.archetypeResolver.getCooldownArchetypes({
      tenantId: context.tenantId,
      domain: context.domain,
      targetHash: step.targetHash,
    });

    // Rank by word-overlap (desc), tiebreak by name length (asc).
    const ranked = rankCandidates(candidates, step.targetDescription).slice(0, 5);

    // Top-score lock: an archetype match on a lower-scoring candidate cannot
    // beat a higher-scoring candidate that has no archetype. Otherwise the
    // resolver silently reroutes from the correct element ("username" input,
    // no archetype) to an unrelated lower-scoring one ("password" input,
    // password_input archetype). Accept archetype hits only from candidates
    // tied with the top score.
    const topScore = ranked.length > 0 ? ranked[0].score : 0;

    // Tied top-score bail (S5): when ≥ 2 candidates tie at the top overlap
    // score, L0 has no basis to pick one. The keyword ranker has already used
    // every signal it has; a tie means the DOM genuinely exposes two
    // equivalent candidates (e.g. signup vs. login email inputs both labelled
    // "Email Address" on automationexercise.com). Fall through to L1..L5 —
    // the LLM sees parent context the ranker does not and can disambiguate.
    const topTieCount = ranked.filter((r) => r.score === topScore).length;
    if (topTieCount >= 2) {
      this.observability.increment('archetype_resolver.top_tie_skip');
      this.observability.increment('resolver.archetype_miss');
      return MISS;
    }

    const page = context.page as PlaywrightPageLike;

    for (const { candidate, score } of ranked) {
      if (score < topScore) {
        this.observability.increment('archetype_resolver.lower_score_skip');
        break;
      }
      const match = await this.archetypeResolver.match(candidate, step.action);
      if (!match) continue;

      // Skip archetypes the user marked failed for this target within the cooldown window.
      if (cooldown.archetypes.has(match.archetypeName)) {
        this.observability.increment('archetype_resolver.cooldown_skip', {
          archetype: match.archetypeName,
        });
        continue;
      }

      // Also skip any candidate selector that the user previously rejected for this target,
      // even if it was proposed by a different archetype.
      if (cooldown.selectors.has(match.selector)) {
        this.observability.increment('archetype_resolver.selector_cooldown_skip', {
          selector: match.selector,
        });
        continue;
      }

      // Validate the ARIA selector against the live DOM before committing
      try {
        const handle = await page.$(match.selector);
        if (handle === null) {
          this.observability.increment('resolver.archetype_dom_miss', { archetype: match.archetypeName });
          continue; // try next candidate
        }
      } catch (e: any) {
        this.observability.log('warn', 'archetype_resolver.dom_validation_failed', {
          archetype: match.archetypeName,
          selector: match.selector,
          error: e.message,
        });
        continue; // try next candidate
      }

      this.observability.increment('resolver.cache_hit', { source: 'archetype' });
      return {
        selectors: [{ selector: match.selector, strategy: 'aria', confidence: match.confidence }],
        fromCache: false,
        cacheSource: null,
        resolutionSource: 'archetype',
        similarityScore: null,
        tokensUsed: 0,
        archetypeName: match.archetypeName,
      };
    }

    this.observability.increment('resolver.archetype_miss');
    return MISS;
  }

  async recordSuccess(_contentHash: string, _domain: string, _selectorUsed: string): Promise<void> {
    // No-op: archetype resolutions don't write to selector_cache, so there's
    // no tenant-scoped row to confirm. Success signal is implicit — the step
    // passed, and the verdict route never fires for passed steps.
  }

  async recordFailure(_targetHash: string, _domain: string, _selectorAttempted: string): Promise<void> {
    // No-op: the UI verdict route (src/api/routes/runs.ts) owns the
    // archetype_failures write path. It reads step_results.archetype_name to
    // know which archetype to cool down, so this worker-side resolver instance
    // never needs to observe user-driven failures. Worker-observed failures
    // (execution errors, DOM changes mid-run) are not user intent and must
    // not cool down an archetype.
  }
}
