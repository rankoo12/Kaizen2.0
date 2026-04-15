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

    const topCandidate = pickTopCandidate(candidates, step.targetDescription);

    const match = await this.archetypeResolver.match(topCandidate, step.action);

    if (!match) {
      this.observability.increment('resolver.archetype_miss');
      return MISS;
    }

    // Validate the ARIA selector against the live DOM before committing
    try {
      const page = context.page as PlaywrightPageLike;
      const handle = await page.$(match.selector);

      if (handle === null) {
        this.observability.increment('resolver.archetype_dom_miss', { archetype: match.archetypeName });
        return MISS;
      }
    } catch (e: any) {
      this.observability.log('warn', 'archetype_resolver.dom_validation_failed', {
        archetype: match.archetypeName,
        selector: match.selector,
        error: e.message,
      });
      return MISS;
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

  // Archetypes are static — no success/failure tracking needed
  async recordSuccess(_contentHash: string, _domain: string, _selectorUsed: string): Promise<void> {}
  async recordFailure(_contentHash: string, _domain: string, _selectorAttempted: string): Promise<void> {}
}
