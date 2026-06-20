/**
 * Maps a raw step_results.resolution_source value to the human-readable cache
 * tier label shown on the run details page. The tier (L0–L5) tells the viewer
 * *how* Kaizen located the element — the differentiator versus a flat report.
 *
 * Spec: docs/specs/tests-ux/spec-run-details-showcase.md §3
 */
export type ResolutionTier = {
  /** Short tier code, e.g. "L5". */
  code: string;
  /** Human label, e.g. "LLM". */
  label: string;
  /** Whether this tier was a cache hit (vs. a live LLM call). */
  cached: boolean;
};

const TIERS: Record<string, ResolutionTier> = {
  archetype:        { code: 'L0', label: 'Archetype',          cached: true },
  redis:            { code: 'L1', label: 'Redis cache',        cached: true },
  db_exact:         { code: 'L2', label: 'Postgres exact',     cached: true },
  pgvector_step:    { code: 'L3', label: 'Vector (tenant)',    cached: true },
  pgvector_element: { code: 'L4', label: 'Vector (shared)',    cached: true },
  llm:              { code: 'L5', label: 'LLM',                cached: false },
};

export function resolutionTier(source: string | null | undefined): ResolutionTier | null {
  if (!source) return null;
  return TIERS[source] ?? { code: '··', label: source, cached: false };
}

/** Convenience: "L5 · LLM" style one-liner. Returns null when source is absent. */
export function resolutionSourceLabel(source: string | null | undefined): string | null {
  const tier = resolutionTier(source);
  return tier ? `${tier.code} · ${tier.label}` : null;
}
