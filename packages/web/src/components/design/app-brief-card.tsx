'use client';
/* What Kaizen understands about an app — a durable, versioned artifact rather
   than a job byproduct, so it lives with the suite and survives the job that
   produced it. Every journey shown here was verified against the observed link
   graph: the model proposes, the graph disposes.
   Spec: docs/specs/tests-ux/spec-testwriter-ux.md §4.8 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { Disclose } from './chrome';
import { I } from './icons';

const { useState, useEffect } = React;

type Journey = {
  name: string;
  description: string;
  pagePath: string[];
  requiresAuth: boolean;
  priority: 'critical' | 'high' | 'normal';
};

type AppBrief = {
  version: number;
  appType: string | null;
  summary: string | null;
  coreEntities: string[];
  journeys: Journey[];
  createdAt: string;
  history: Array<{ version: number; createdAt: string }>;
};

const PRIORITY_TONE: Record<string, string> = {
  critical: 'var(--fail)', high: 'var(--warn)', normal: 'var(--idle)',
};

function pathOf(url: string): string {
  try { return new URL(url).pathname || '/'; } catch { return url; }
}

export function AppBriefCard({ suiteId, onReanalyze }: {
  suiteId: string;
  onReanalyze?: () => void;
}) {
  const [brief, setBrief] = useState<AppBrief | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/proxy/suites/${suiteId}/app-brief`);
        if (!cancelled) {
          setBrief(r.ok ? (await r.json()).appBrief : null);
          setChecked(true);
        }
      } catch {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, [suiteId]);

  // A suite Kaizen has never explored simply has no brief — show nothing rather
  // than an empty shell inviting the user to wonder what's missing.
  if (!checked || !brief) return null;

  return (
    <div className="card" style={{ padding: '0 16px', marginBottom: 14 }}>
      <Disclose
        title="What Kaizen knows about this app"
        accent="var(--accent)"
        badge={<span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>
          v{brief.version}
        </span>}
      >
        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <I.sparkle size={13} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{brief.appType || 'Application'}</span>
            </div>
            {brief.summary && (
              <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55, marginTop: 5 }}>
                {brief.summary}
              </div>
            )}
          </div>

          {brief.coreEntities.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
              Entities: <span style={{ color: 'var(--text-2)' }}>{brief.coreEntities.join(' · ')}</span>
            </div>
          )}

          {brief.journeys.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Journeys — verified against the real link graph
              </div>
              <div style={{ display: 'grid', gap: 7 }}>
                {brief.journeys.map((j) => (
                  <div key={j.name}
                    title="Every hop in this path was observed as a real link by the crawler">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', flex: 'none',
                        background: PRIORITY_TONE[j.priority] ?? 'var(--idle)' }} />
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{j.name}</span>
                      {j.requiresAuth && (
                        <span className="badge" style={{ fontSize: 10, color: 'var(--warn)' }}>
                          NEEDS SIGN-IN
                        </span>
                      )}
                    </div>
                    <div className="num" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, paddingLeft: 13 }}>
                      {j.pagePath.map(pathOf).join(' → ')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {onReanalyze && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 }}>
              <span style={{ flex: 1, fontSize: 11, color: 'var(--text-3)' }}>
                Explored {new Date(brief.createdAt).toLocaleDateString()}
                {brief.history.length > 1 && ` · ${brief.history.length} versions`}
              </span>
              <button className="btn" onClick={onReanalyze}>
                <I.sparkle size={12} />Re-analyze
              </button>
            </div>
          )}
        </div>
      </Disclose>
    </div>
  );
}
