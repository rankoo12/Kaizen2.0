/**
 * Spec ref: Smart Brain Layer 0 — Element Archetype Library
 *
 * Queries the element_archetypes table to match a DOM candidate against a known
 * universal UI pattern. Returns an ARIA selector on match; null on miss.
 *
 * In-memory cache: archetypes change rarely. Rows are loaded once per process
 * and refreshed in the background after ARCHETYPE_CACHE_TTL_MS (5 minutes)
 * so hot resolution paths are never blocked by a DB round-trip.
 */

import { getPool } from '../../db/pool';
import type { IObservability } from '../observability/interfaces';
import type { CandidateNode } from '../../types';
import type { IArchetypeResolver, ArchetypeMatch } from './archetype.interfaces';

const ARCHETYPE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type ArchetypeRow = {
  name: string;
  role: string;
  name_patterns: string[];
  action_hint: string | null;
  confidence: number;
};

function normalise(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

function buildAriaSelector(role: string, accessibleName: string): string {
  const escaped = accessibleName.replace(/"/g, '\\"');
  return `role=${role}[name="${escaped}"]`;
}

export class DBArchetypeResolver implements IArchetypeResolver {
  private cache: ArchetypeRow[] | null = null;
  private cacheExpiresAt = 0;

  constructor(private readonly observability: IObservability) {}

  private async getArchetypes(): Promise<ArchetypeRow[]> {
    if (this.cache !== null && Date.now() < this.cacheExpiresAt) {
      return this.cache;
    }

    try {
      const { rows } = await getPool().query<ArchetypeRow>(
        `SELECT name, role, name_patterns, action_hint, confidence
         FROM element_archetypes
         ORDER BY role, name`,
      );
      this.cache = rows;
      this.cacheExpiresAt = Date.now() + ARCHETYPE_CACHE_TTL_MS;
      return rows;
    } catch (e: any) {
      this.observability.log('warn', 'archetype_resolver.fetch_failed', { error: e.message });
      // Return stale cache if available so the resolver degrades gracefully
      return this.cache ?? [];
    }
  }

  /**
   * Automatically promotes a newly-observed accessible name into the matching
   * archetype's name_patterns when the LLM resolves an element that we didn't
   * know about yet.
   *
   * Algorithm:
   *  1. Filter archetypes by the candidate's role (and action_hint if set).
   *  2. Score each archetype by keyword overlap between its existing patterns
   *     and the new normalised name.
   *  3. If there is one clear winner (highest score, no tie), add the new pattern.
   *  4. Bust the in-memory cache so the next run sees the pattern immediately.
   *
   * Fire-and-forget safe — never throws; all errors are logged as warnings.
   */
  async learn(role: string, name: string, action: string): Promise<void> {
    const normName = normalise(name);
    // Skip empty names and suspiciously long ones (likely dynamic text, not a label)
    if (!normName || normName.length > 80) return;

    let archetypes: ArchetypeRow[];
    try {
      archetypes = await this.getArchetypes();
    } catch {
      return;
    }

    const candidates = archetypes.filter(
      (a) => a.role === role && (a.action_hint === null || a.action_hint === action),
    );
    if (candidates.length === 0) return;

    // Score each archetype: how many keyword tokens from its existing patterns
    // overlap with tokens in the new name?
    const nameTokens = normName.split(/\s+/).filter((w) => w.length > 2);
    if (nameTokens.length === 0) return;

    const scored = candidates.map((a) => {
      const score = a.name_patterns.reduce((best, p) => {
        const patternCore = p.endsWith('*') ? p.slice(0, -1) : p;
        const patternTokens = patternCore.split(/\s+/).filter((w) => w.length > 2);
        const overlap = patternTokens.filter((w) => nameTokens.includes(w)).length;
        return Math.max(best, overlap);
      }, 0);
      return { archetype: a, score };
    }).sort((a, b) => b.score - a.score);

    // Require a clear winner: score > 0 and no other archetype tied for first place
    if (scored[0].score === 0) return;
    if (scored.length > 1 && scored[0].score === scored[1].score) return;

    const target = scored[0].archetype;

    // Check if this name is already covered (exact or wildcard)
    const alreadyCovered = target.name_patterns.some((p) =>
      p.endsWith('*') ? normName.startsWith(p.slice(0, -1)) : normName === p,
    );
    if (alreadyCovered) return;

    try {
      await getPool().query(
        `UPDATE element_archetypes
         SET name_patterns = array_append(name_patterns, $1)
         WHERE name = $2
           AND NOT ($1 = ANY(name_patterns))`,
        [normName, target.name],
      );
      // Bust the cache so the next resolution picks up the new pattern immediately
      this.cache = null;
      this.cacheExpiresAt = 0;
      this.observability.increment('archetype_learner.pattern_added', { archetype: target.name });
      this.observability.log('info', 'archetype_learner.pattern_added', {
        archetype: target.name,
        pattern: normName,
      });
    } catch (e: any) {
      this.observability.log('warn', 'archetype_learner.learn_failed', { error: e.message });
    }
  }

  async match(candidate: CandidateNode, action: string): Promise<ArchetypeMatch | null> {
    const archetypes = await this.getArchetypes();

    // Pre-filter by role — most archetypes only match one role
    const byRole = archetypes.filter((a) => a.role === candidate.role);
    if (byRole.length === 0) return null;

    const normalisedName = normalise(candidate.name || candidate.textContent);
    if (!normalisedName) return null;

    for (const archetype of byRole) {
      // Respect action_hint: if set, action must match
      if (archetype.action_hint !== null && archetype.action_hint !== action) continue;

      // Pattern matching: exact match, or prefix match when pattern ends with '*'
      const nameMatches = archetype.name_patterns.some((p) =>
        p.endsWith('*') ? normalisedName.startsWith(p.slice(0, -1)) : normalisedName === p,
      );
      if (nameMatches) {
        const selector = buildAriaSelector(candidate.role, candidate.name || candidate.textContent);
        return {
          archetypeName: archetype.name,
          selector,
          confidence: Number(archetype.confidence),
        };
      }
    }

    return null;
  }
}
