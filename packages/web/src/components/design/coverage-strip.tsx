'use client';
/* What the suite does not cover.

   Coverage lives here rather than on the delivery face because of what the
   number is FOR: "what is my suite missing" is a question about the suite,
   asked repeatedly over weeks. The delivery face is a per-job story that is
   over once the drafts are accepted, and burying a durable answer inside a
   disposable narrative loses it. A screen of its own is Mission 6's job.

   The endpoint has existed, complete and honest, with no UI at all.
   Spec: docs/specs/test-writer/spec-findings-and-coverage.md §3.2, §4 */
import * as React from 'react';
import { Disclose } from './chrome';

const { useState, useEffect } = React;

type CoveragePage = {
  url: string;
  purposeTag: string | null;
  requiresAuth: boolean;
  caseCount: number;
  tested: boolean;
};

type Coverage = {
  pages: CoveragePage[];
  summary: { total: number; tested: number; untested: number };
  coverageConfidence: 'observed' | 'unknown';
  confidenceReason: string | null;
};

function pathOf(url: string): string {
  try { return new URL(url).pathname || '/'; } catch { return url; }
}

export function CoverageStrip({ suiteId }: { suiteId: string }) {
  const [coverage, setCoverage] = useState<Coverage | null>(null);

  useEffect(() => {
    let alive = true;
    setCoverage(null);
    void (async () => {
      try {
        const r = await fetch(`/api/proxy/suites/${suiteId}/coverage`);
        if (!r.ok) return;
        const { coverage: c } = await r.json();
        if (alive) setCoverage(c ?? null);
      } catch { /* a suite with no model yet simply has no strip */ }
    })();
    return () => { alive = false; };
  }, [suiteId]);

  // Nothing crawled means nothing to say. An empty coverage strip on a suite
  // Kaizen has never explored would read as "0% covered" when the truth is
  // "no map yet" — a different statement entirely.
  if (!coverage || coverage.summary.total === 0) return null;

  const { summary, coverageConfidence, confidenceReason } = coverage;
  const untested = coverage.pages.filter((p) => !p.tested);
  const unknown = coverageConfidence === 'unknown';

  return (
    <div className="card" style={{ padding: '0 16px' }}>
      <Disclose
        title={
          /* No ratio at all when the map itself is incomplete. Not greyed, not
             caveated, not "3 of 3 (limited)" — a percentage a user half-reads is
             remembered as a percentage, and "1 of 1 covered" off a one-page
             crawl is the most dishonest thing this feature could print. */
          unknown
            ? 'Coverage can’t be assessed yet'
            : `${summary.tested} of ${summary.total} known pages have a test`
        }
      >
        <div style={{ display: 'grid', gap: 8 }}>
          {unknown ? (
            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55 }}>
              {confidenceReason ?? 'Too little of the app was reachable to judge coverage.'}
              {' '}Re-analyze once the site is reachable — anti-bot rules, robots.txt and
              sign-in walls all narrow what Kaizen can map.
            </div>
          ) : untested.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--pass)', lineHeight: 1.55 }}>
              Every page Kaizen knows about is touched by an active test in this suite.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
                A page counts as covered when an active test in this suite goes there —
                deliberately literal, so this is a floor rather than a guess.
              </div>
              <div className="list">
                {untested.map((p) => (
                  <div key={p.url} className="row" style={{ padding: '8px 12px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="num" style={{ fontSize: 12, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pathOf(p.url)}</div>
                      {p.purposeTag && <div className="row-s">{p.purposeTag}</div>}
                    </div>
                    {/* The gap most worth converting, and it points straight at
                        signed-in exploration. */}
                    {p.requiresAuth && (
                      <span className="badge" style={{ color: 'var(--warn)', fontSize: 10 }}>
                        BEHIND SIGN-IN
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </Disclose>
    </div>
  );
}
