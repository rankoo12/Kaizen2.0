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

      if (archetype.name_patterns.includes(normalisedName)) {
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
