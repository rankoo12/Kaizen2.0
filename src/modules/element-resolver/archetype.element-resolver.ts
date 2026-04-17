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

/**
 * Ranks candidates by word-overlap with the target description.
 * Tiebreaker: shorter accessible name wins — "Sign in" is more specific
 * than "Sign in with a passkey" for the same overlap score.
 */
function rankCandidates(candidates: CandidateNode[], target: string): CandidateNode[] {
  const words = target.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return candidates;

  return [...candidates].sort((a, b) => {
    const scoreA = words.reduce((n, w) => {
      const hay = `${a.role} ${a.name ?? ''} ${a.textContent ?? ''}`.toLowerCase();
      return n + (hay.includes(w) ? 1 : 0);
    }, 0);
    const scoreB = words.reduce((n, w) => {
      const hay = `${b.role} ${b.name ?? ''} ${b.textContent ?? ''}`.toLowerCase();
      return n + (hay.includes(w) ? 1 : 0);
    }, 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    // Tiebreak: prefer the candidate with the shorter accessible name (more exact match)
    return (a.name || a.textContent).length - (b.name || b.textContent).length;
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

    // Rank by word-overlap (desc), tiebreak by name length (asc).
    // Try the top-5 candidates so that a high-scoring but non-matching candidate
    // (e.g. "Sign in with a passkey") does not block the correct shorter match.
    const ranked = rankCandidates(candidates, step.targetDescription).slice(0, 5);
    const page = context.page as PlaywrightPageLike;

    for (const candidate of ranked) {
      const match = await this.archetypeResolver.match(candidate, step.action);
      if (!match) continue;

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
      };
    }

    this.observability.increment('resolver.archetype_miss');
    return MISS;
  }

  // Archetypes are static — no success/failure tracking needed
  async recordSuccess(_contentHash: string, _domain: string, _selectorUsed: string): Promise<void> {}
  async recordFailure(_contentHash: string, _domain: string, _selectorAttempted: string): Promise<void> {}
}
