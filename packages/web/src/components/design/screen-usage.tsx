'use client';
/* Usage / Settings — design markup from `Kaizen (1)/native/screen-settings.jsx`, on real data.

   Real: tokens + runs this month and member count (GET /tenants/:id/usage), the members
   list (GET /tenants/:id/members), the cost-per-run chart (computed from the tenant's
   actual runs), appearance, and sign-out.
   Honest gaps: the monthly token budget isn't returned by any endpoint, so there's no
   quota meter — the number is shown without a denominator. The API issues one tenant
   key with no list endpoint, so the design's multi-key table is a single rotate action
   instead of four invented keys. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I } from './icons';
import { Toolbar, Seg, Stat, Switch, Sheet, ConfirmSheet } from './chrome';
import { fmt } from './data';
import { useAuth } from '@/context/auth-context';
import type { RunSummary } from '@/types/api';

const { useState: uSu, useEffect: uEu } = React;

type Usage = { runsThisMonth: number; llmTokensThisMonth: number; memberCount: number };
type Member = { id: string; role: string; acceptedAt: string | null; user: { id: string; email: string; displayName: string } };

function CostChart({ runs }: { runs: RunSummary[] }) {
  const max = Math.max(...runs.map((r) => r.totalTokens ?? 0), 1);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 118 }}>
      {runs.map((r, i) => {
        const v = r.totalTokens ?? 0;
        return (
          <div key={r.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 2 }}
            title={`${r.caseName ?? 'run'} · ${fmt.n(v)} tokens`}>
            <div style={{
              height: `${Math.max(v / max * 100, v === 0 ? 2 : 4)}%`, borderRadius: 3,
              // A free run is the win, so it gets the memory colour rather than the neutral.
              background: v === 0 ? 'var(--heal)' : 'var(--accent)',
              opacity: v === 0 ? .55 : .3 + (i / Math.max(runs.length - 1, 1)) * .7,
              transition: 'height .5s',
            }} />
          </div>
        );
      })}
    </div>
  );
}

export function UsageScreen({ appearance, setAppearance, group, setGroup, showToast }: {
  appearance: string; setAppearance: (v: string) => void;
  group: boolean; setGroup: (v: boolean) => void;
  showToast: (msg: string, kind?: string) => void;
}) {
  const { user, logout } = useAuth();
  const tenantId = (user as any)?.tenantId as string | undefined;

  const [tab, setTab] = uSu('usage');
  const [usage, setUsage] = uSu<Usage | null>(null);
  const [usageErr, setUsageErr] = uSu(false);
  const [runs, setRuns] = uSu<RunSummary[]>([]);
  const [members, setMembers] = uSu<Member[] | null>(null);
  const [confirmRotate, setConfirmRotate] = uSu(false);
  const [newKey, setNewKey] = uSu<string | null>(null);

  uEu(() => {
    if (!tenantId) return;
    fetch(`/api/proxy/tenants/${tenantId}/usage`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => setUsage(b.usage))
      .catch(() => setUsageErr(true));
    fetch(`/api/proxy/tenants/${tenantId}/members`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => setMembers(b.members ?? []))
      .catch(() => setMembers([]));
    fetch('/api/proxy/runs?limit=50', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => setRuns(b.runs ?? []))
      .catch(() => setRuns([]));
  }, [tenantId]);

  // Oldest → newest so the chart reads left to right like a timeline.
  const costed = runs.filter((r) => r.totalTokens != null).slice().reverse();
  const free = costed.filter((r) => r.totalTokens === 0).length;
  const firstCost = costed[0]?.totalTokens ?? null;
  const lastCost = costed[costed.length - 1]?.totalTokens ?? null;
  const maxCost = Math.max(0, ...costed.map((r) => r.totalTokens ?? 0));
  const cheaper = firstCost && lastCost != null && firstCost > 0 ? Math.round((1 - lastCost / firstCost) * 100) : null;

  async function rotateKey() {
    if (!tenantId) return;
    try {
      const r = await fetch(`/api/proxy/tenants/${tenantId}/api-key`, { method: 'POST' });
      if (!r.ok) throw new Error();
      const b = await r.json();
      setNewKey(b.key);
    } catch {
      showToast('Could not rotate the key — owners only', 'error');
    }
  }

  return (
    <>
      <Toolbar title="Usage" sub={user?.email ? `Signed in as ${user.email}` : 'Workspace'}>
        <Seg value={tab} onChange={setTab} options={[
          { value: 'usage', label: 'Usage' }, { value: 'keys', label: 'API key' },
          { value: 'members', label: 'Members' }, { value: 'appearance', label: 'Appearance' },
        ]} />
      </Toolbar>

      <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px' }}>
        {tab === 'usage' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 940 }}>
            <div className="card rise" style={{ padding: 17 }}>
              <div className="card-t">Tokens this month</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 7 }}>
                <span className="num" style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-.02em' }}>
                  {usage ? fmt.n(usage.llmTokensThisMonth) : usageErr ? '—' : '…'}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-3)' }}>spent on finding elements</span>
              </div>
              <div style={{ display: 'flex', marginTop: 15, borderTop: '.5px solid var(--sep)' }}>
                <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}>
                  <Stat label="Runs this month" value={usage ? fmt.n(usage.runsThisMonth) : '—'} sub="across all suites" />
                </div>
                <div style={{ flex: '1 1 148px', minWidth: 0, borderRight: '.5px solid var(--sep)' }}>
                  <Stat label="Free runs" value={costed.length ? `${Math.round(free / costed.length * 100)}%` : '—'}
                    tone="var(--cache)" sub={costed.length ? `${free} of the last ${costed.length} cost nothing` : 'no runs yet'} />
                </div>
                <div style={{ flex: 1 }}>
                  <Stat label="Members" value={usage ? usage.memberCount : '—'} sub="in this workspace" />
                </div>
              </div>
              {usageErr && (
                <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 13, padding: '10px 12px', background: 'var(--warn-soft)', borderRadius: 8 }}>
                  <I.info size={13} style={{ color: 'var(--warn)', marginTop: 1, flex: 'none' }} />
                  <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                    Usage totals need admin rights on this workspace, so they&rsquo;re hidden for your role.
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 13, padding: '10px 12px', background: 'var(--fill)', borderRadius: 8 }}>
                <I.info size={13} style={{ color: 'var(--text-3)', marginTop: 1, flex: 'none' }} />
                <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
                  Every workspace has a monthly token budget. Go over it and new runs are rejected the moment
                  they&rsquo;re submitted, with the reason on the run, rather than failing halfway through.
                </div>
              </div>
            </div>

            <div className="card" style={{ padding: 17 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div className="card-t">Tokens per run</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                    The line that matters: a mature test should cost close to nothing.
                  </div>
                </div>
                {cheaper != null && cheaper > 0 && (
                  <span className="badge" style={{ background: 'var(--pass-soft)', color: 'var(--pass)', height: 22, flex: 'none' }}>
                    <I.arrowDown size={10} />{cheaper}% SINCE THE OLDEST
                  </span>
                )}
              </div>
              {!costed.length ? (
                <div style={{ padding: '34px 0 6px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>
                  Run a test and the cost curve starts here.
                </div>
              ) : maxCost === 0 ? (
                /* A chart of all-zeroes reads as broken, not as the win it is. */
                <div style={{ display: 'flex', gap: 11, alignItems: 'center', marginTop: 14, padding: '14px 15px', background: 'var(--cache-soft)', borderRadius: 9 }}>
                  <I.db size={16} style={{ color: 'var(--cache)', flex: 'none' }} />
                  <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
                    Every one of the last {costed.length} run{costed.length === 1 ? '' : 's'} cost <span className="num" style={{ fontWeight: 600, color: 'var(--cache)' }}>0</span> tokens —
                    every element came from memory. There&rsquo;s no curve to plot until something needs the AI again.
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ marginTop: 15 }}><CostChart runs={costed} /></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: 'var(--text-3)' }} className="num">
                    <span>oldest kept · {fmt.n(firstCost as number)} tok</span>
                    <span>newest · {fmt.n(lastCost as number)} tok</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'keys' && (
          <div style={{ maxWidth: 720 }}>
            <div className="card" style={{ padding: 17 }}>
              <div className="card-t">Workspace API key</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.55 }}>
                One key per workspace, for CI and scripts. Only its hash is stored, so the secret is shown once —
                rotating replaces it immediately and anything still using the old key stops working.
              </div>
              <button className="btn" style={{ marginTop: 13 }} onClick={() => setConfirmRotate(true)}>
                <I.keys size={13} />Rotate key
              </button>
            </div>
            <div className="card" style={{ marginTop: 14, padding: 15 }}>
              <div className="label">Trigger a run from CI</div>
              <pre className="num scroll" style={{ margin: '8px 0 0', fontSize: 12, background: 'var(--fill)', padding: '11px 13px', borderRadius: 8, lineHeight: 1.65, overflowX: 'auto' }}>{`curl -X POST http://localhost:3000/runs \\
  -H "X-API-Key: <your key>" \\
  -H "Content-Type: application/json" \\
  -d '{"caseId":"<case id>"}'`}</pre>
            </div>
          </div>
        )}

        {tab === 'members' && (
          <div style={{ maxWidth: 720 }}>
            <div className="list">
              <div className="list-h"><span style={{ width: 26 }} /><span style={{ flex: 1 }}>MEMBER</span><span style={{ width: 130 }}>ROLE</span><span style={{ width: 110, textAlign: 'right' }}>JOINED</span></div>
              {(members ?? []).map((m) => {
                const name = m.user.displayName || m.user.email;
                const initials = name.trim().split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
                return (
                  <div className="row" key={m.id} style={{ cursor: 'default' }}>
                    <span style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--fill-2)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-2)', flex: 'none' }}>{initials}</span>
                    <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                      <div className="row-t">{name}{m.user.id === user?.id ? ' (you)' : ''}</div>
                      <div className="row-s num">{m.user.email}</div>
                    </div>
                    <span style={{ width: 130, flex: 'none' }}><span className="pill">{m.role}</span></span>
                    <span className="num" style={{ width: 110, flex: 'none', textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>
                      {m.acceptedAt ? new Date(m.acceptedAt).toLocaleDateString() : 'invited'}
                    </span>
                  </div>
                );
              })}
              {members && !members.length && (
                <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>No members to show.</div>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.55, padding: '0 4px' }}>
              Everything in Kaizen belongs to a workspace. Members only ever see this workspace&rsquo;s data; roles decide who can
              author tests, trigger runs, and manage keys.
            </div>
          </div>
        )}

        {tab === 'appearance' && (
          <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="list">
              <div className="list-h">APPEARANCE</div>
              <div className="row" style={{ cursor: 'default' }}>
                <div style={{ flex: 1 }}><div className="row-t">Theme</div><div className="row-s">Aperture is the industrial skin; light and dark are the system ones.</div></div>
                <Seg value={appearance} onChange={setAppearance} options={[
                  { value: 'aperture', label: 'Aperture' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' },
                ]} />
              </div>
              <div className="row" style={{ cursor: 'default' }}>
                <div style={{ flex: 1 }}><div className="row-t">Group tests by suite</div><div className="row-s">Off shows one flat list.</div></div>
                <Switch checked={group} onChange={setGroup} />
              </div>
            </div>
            <div className="list">
              <div className="list-h">SESSION</div>
              <div className="row" style={{ cursor: 'default' }}>
                <div style={{ flex: 1 }}>
                  <div className="row-t">{user?.displayName || user?.email}</div>
                  <div className="row-s num">{user?.email}</div>
                </div>
                <button className="btn danger" onClick={() => logout()}>Sign out</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {confirmRotate && (
        <ConfirmSheet title="Rotate the workspace API key?"
          message="The current key stops working the moment the new one is issued — including any CI pipeline using it. The new secret is shown once."
          confirmLabel="Rotate key"
          onConfirm={rotateKey}
          onClose={() => setConfirmRotate(false)} />
      )}

      {newKey && (
        <Sheet title="Your new API key" width={460} onClose={() => setNewKey(null)} footer={
          <>
            <button className="btn lg" onClick={() => { navigator.clipboard?.writeText(newKey); showToast('Key copied', 'success'); }}>
              <I.copy size={13} />Copy
            </button>
            <button className="btn pri lg" onClick={() => setNewKey(null)}>Done</button>
          </>
        }>
          <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.55 }}>
            Copy it now — it isn&rsquo;t stored in a readable form and won&rsquo;t be shown again.
          </div>
          <div className="num" style={{ marginTop: 10, fontSize: 12, background: 'var(--fill)', padding: '10px 12px', borderRadius: 8, wordBreak: 'break-all' }}>{newKey}</div>
        </Sheet>
      )}
    </>
  );
}
