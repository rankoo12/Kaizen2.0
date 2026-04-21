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
    // tied with the top score — this preserves genuine ties (e.g. "Sign in"
    // vs. "Sign in with a passkey" tie on overlap, archetype filters within
    // that tie) but blocks semantic drift across score buckets.
    const topScore = ranked.length > 0 ? ranked[0].score : 0;
    const page = context.page as PlaywrightPageLike;

    for (const { candidate, score } of ranked) {
      if (score < topScore) {
        this.observability.increment('archetype_resolver.lower_score_skip');
        break;
      }
      const match = await this.archetypeResolver.match(candidate, step.action);
      if (!match) continue;

      // Skip archetypes the user marked failed for this target within the cooldown window.
      if (cooldown.has(match.archetypeName)) {
        this.observability.increment('archetype_resolver.cooldown_skip', {
          archetype: match.archetypeName,
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
      this.lastMatch = {
        key: {
          tenantId: context.tenantId,
          domain: context.domain,
          targetHash: step.targetHash,
        },
        archetypeName: match.archetypeName,
        selector: match.selector,
      };
      return {
        selectors: [{ selector: match.selector, strategy: 'aria', confidence: match.confidence }],
        fromCache: false,
        cacheSource: null,
        resolutionSource: 'archetype',
        similarityScore: null,
        tokensUsed: 0,
      };
    }

    this.observability.increment('resolver.archetype_miss');
    return MISS;
  }

  /**
   * Remembers the last archetype that we resolved so that a subsequent
   * recordFailure() call from the worker can be attributed to the correct
   * (tenantId, domain, targetHash, archetypeName) tuple. Cleared after use.
   */
  private lastMatch: {
    key: { tenantId: string; domain: string; targetHash: string };
    archetypeName: string;
    selector: string;
  } | null = null;

  async recordSuccess(_contentHash: string, _domain: string, _selectorUsed: string): Promise<void> {
    // Success wipes the last-match slot — cooldown is driven only by failures.
    this.lastMatch = null;
  }

  async recordFailure(targetHash: string, domain: string, selectorAttempted: string): Promise<void> {
    // The worker calls recordFailure with targetHash + domain but no tenantId
    // (by design: selectorSet + step carry those). We only have enough context
    // to act when the most recent resolve() on this instance produced this
    // archetype+selector combo.
    const last = this.lastMatch;
    this.lastMatch = null;
    if (!last) return;
    if (last.key.targetHash !== targetHash) return;
    if (last.key.domain !== domain) return;
    if (last.selector !== selectorAttempted) return;

    await this.archetypeResolver.recordFailure(last.key, last.archetypeName, last.selector);
  }
}
