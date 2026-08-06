/* Design vocabulary — NOT mock data.
 *
 * What remains here is the design's fixed vocabulary, not sample content:
 *   SOURCES  label/colour/explanation per resolution tier (screen-run maps the real
 *            resolution_source onto these keys)
 *   NAV      the sidebar's nav items
 *   fmt      number/duration formatters
 *
 * The design's sample content (TENANT, SUITES, CASES, BY_SUITE, FOCUS_CASE, STEPS,
 * RUN, HISTORY, RUNS_FEED, BRAIN, COST_CURVE, API_KEYS) has been deleted. Every screen
 * reads live data now, and unused fixtures are exactly how fake values quietly come
 * back: the sidebar was still falling back to TENANT.user, so a signed-in workspace
 * could flash "Ada Lovelace". Recover them from the design folder if ever needed.
 *
 * Anything placed on screen without a live source must carry the badge from ./mock.
 */

export const SOURCES: Record<string, { label: string; short: string; color: string; tokens: number; note: string }> = {
  pattern: { label: 'Known pattern', short: 'PATTERN', color: 'var(--cache)', tokens: 0, note: 'Matched a structural pattern Kaizen already trusts for this kind of field.' },
  cache:   { label: 'Cached selector', short: 'CACHE', color: 'var(--cache)', tokens: 0, note: 'Exact selector recalled from this workspace’s memory of the site.' },
  vector:  { label: 'Similarity search', short: 'SIMILAR', color: 'var(--accent)', tokens: 0, note: 'Found by comparing this step to past resolutions on similar pages.' },
  global:  { label: 'Global brain', short: 'GLOBAL', color: 'var(--accent)', tokens: 0, note: 'Verified selector shared across all workspaces for this public site.' },
  llm:     { label: 'AI resolution', short: 'AI', color: 'var(--warn)', tokens: 1, note: 'No memory matched, so the model read the page and picked the element.' },
};

export const NAV = [
  { id: 'tests', label: 'Tests', icon: 'tests' },
  { id: 'runs', label: 'Runs', icon: 'runs' },
  // Every analysis Kaizen has run: the audit trail, and the way back to a plan
  // waiting for approval or a delivery nobody reviewed.
  { id: 'analyses', label: 'Analyses', icon: 'sparkle' },
  { id: 'brain', label: 'The Brain', icon: 'brain' },
  { id: 'usage', label: 'Usage', icon: 'usage' },
];

export const fmt = {
  n: (v: number) => v.toLocaleString('en-US'),
  k: (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v)),
  ms: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 2)}s` : `${v}ms`),
  pct: (v: number) => `${Math.round(v)}%`,
};
