/**
 * Minimal robots.txt support for the RECON crawler.
 * Spec ref: docs/specs/test-writer/spec-recon-crawler.md §4.3
 *
 * Honors `User-agent: *` groups only (Kaizen does not register a product
 * token in v1): Disallow/Allow prefix rules, longest-match-wins per the
 * original REP convention, Allow beats Disallow on equal length. Fails OPEN on
 * fetch/parse errors — an unreachable robots.txt must not kill the job — but a
 * successfully-fetched `Disallow: /` is respected.
 */

export type RobotsRules = {
  allows: string[];
  disallows: string[];
};

export const ALLOW_ALL: RobotsRules = { allows: [], disallows: [] };

export function parseRobots(body: string): RobotsRules {
  const allows: string[] = [];
  const disallows: string[] = [];
  let inStarGroup = false;
  // A group is a run of User-agent lines followed by rules; the group applies
  // to * when ANY of its User-agent lines is *.
  let pendingAgents: string[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      pendingAgents.push(value);
      continue;
    }
    // First non-user-agent line closes the agent run.
    if (pendingAgents.length > 0) {
      inStarGroup = pendingAgents.includes('*');
      pendingAgents = [];
    }
    if (!inStarGroup) continue;
    if (field === 'disallow' && value) disallows.push(value);
    if (field === 'allow' && value) allows.push(value);
  }
  return { allows, disallows };
}

/** True when the given pathname may be fetched under the rules. */
export function isAllowed(rules: RobotsRules, pathname: string): boolean {
  const longestMatch = (patterns: string[]): number =>
    patterns.reduce((best, p) => (pathname.startsWith(p) && p.length > best ? p.length : best), -1);

  const allow = longestMatch(rules.allows);
  const disallow = longestMatch(rules.disallows);
  if (disallow === -1) return true;
  return allow >= disallow;
}

/**
 * Fetch and parse robots.txt for an origin. Fails open (allow-all) on any
 * network or HTTP error.
 */
export async function fetchRobots(origin: string): Promise<RobotsRules> {
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return ALLOW_ALL;
    return parseRobots(await res.text());
  } catch {
    return ALLOW_ALL;
  }
}
