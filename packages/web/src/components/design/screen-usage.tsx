'use client';
/* Usage / Settings — design markup from `Kaizen (1)/native/screen-settings.jsx`, on real data.

   Real: tokens + runs this month and member count (GET /tenants/:id/usage), the members
   list (GET /tenants/:id/members), the cost-per-run chart (computed from the tenant's
   actual runs), appearance, and sign-out.
   The two gaps this screen used to carry are closed: GET /tenants/:id/usage now returns
   the monthly budget and the cycle boundary, so the token number has a real denominator;
   and the API key table is live on GET/POST/DELETE /tenants/:id/keys — independently
   scoped, labelled, revocable keys, instead of the one rotate action that wiped every
   key a workspace had. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I } from './icons';
import { Toolbar, Seg, Stat, Switch, Sheet, ConfirmSheet } from './chrome';
import { fmt } from './data';
import { useAuth } from '@/context/auth-context';
import type { RunSummary } from '@/types/api';

const { useState: uSu, useEffect: uEu, useCallback: uCu } = React;

type Usage = {
  runsThisMonth: number; llmTokensThisMonth: number; memberCount: number;
  /** 0 means no allowance is configured — a different state from being over one. */
  budgetTokensMonthly: number;
  cycleStart: string; cycleEnd: string;
};
type HistoryPoint = {
  day: string; runs: number; tokens: number;
  lookups: number; cacheHits: number; heals: number; failures: number;
};
type ApiKey = {
  id: string; keyPrefix: string; scope: 'read_only' | 'execute' | 'admin';
  description: string | null; createdAt: string; lastUsedAt: string | null; expiresAt: string | null;
};
type Member = { id: string; role: string; acceptedAt: string | null; user: { id: string; email: string; displayName: string } };

/* The denominator the Usage screen never had. Budget 0 is NOT "0% used" — it means no
   allowance is configured, which rejects runs with a different 402 than exhausting one,
   so it gets its own copy rather than an empty meter that reads as plenty left. */
function QuotaMeter({ usage }: { usage: Usage }) {
  const { llmTokensThisMonth: used, budgetTokensMonthly: budget, cycleEnd } = usage;
  const resets = (() => {
    const d = new Date(cycleEnd);
    // Plain toLocaleDateString, not { month: 'short' }: the short-month form injects a
    // localised month NAME into otherwise-English copy ("resets 1 בספט׳" on a Hebrew
    // system). A numeric date reads correctly in every locale, and matches how the keys
    // table and members list already render dates.
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
  })();

  if (budget <= 0) {
    return (
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 13, padding: '10px 12px', background: 'var(--warn-soft)', borderRadius: 8 }}>
        <I.info size={13} style={{ color: 'var(--warn)', marginTop: 1, flex: 'none' }} />
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>
          This workspace has no token allowance, so new runs are rejected at submit. Ask the
          workspace owner to allocate tokens.
        </div>
      </div>
    );
  }

  const pct = Math.min(100, (used / budget) * 100);
  const over = used >= budget;
  // Warn before it bites, not after: at 80% there's still time to act.
  const tone = over ? 'var(--fail)' : pct >= 80 ? 'var(--warn)' : 'var(--accent)';

  return (
    <div style={{ marginTop: 12 }}>
      <div className="meter" style={{ height: 8 }}>
        <i style={{ width: `${pct}%`, background: tone }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11.5, color: 'var(--text-3)' }}>
        <span>
          {over
            ? 'Limit reached — new runs are rejected until it resets'
            : `${fmt.n(Math.max(0, budget - used))} left this cycle`}
        </span>
        {resets && <span className="num">resets {resets}</span>}
      </div>
    </div>
  );
}

/* The 30-day series, which is what the design's headline chart always meant. The old
   chart plotted individual recent runs, so it could not show a trend over time - a busy
   day and a quiet day occupied the same width. This plots days, with quiet days present
   and empty, so the shape of the curve is honest.
   Spec: docs/specs/roadmap/spec-cost-history-and-case-stats.md §4.1 */
function HistoryChart({ series }: { series: HistoryPoint[] }) {
  // Tokens PER RUN, not tokens total: a day with 20 cheap runs should not tower over a
  // day with one expensive one. Per-run cost is the number that should trend to zero.
  const perRun = series.map((p) => (p.runs > 0 ? p.tokens / p.runs : null));
  const max = Math.max(1, ...perRun.map((v) => v ?? 0));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 118 }}>
        {series.map((p, i) => {
          const v = perRun[i];
          const idle = v === null;
          const pct = idle ? 0 : Math.max((v / max) * 100, v === 0 ? 2 : 4);
          return (
            <div key={p.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 2 }}
              title={idle
                ? `${p.day} · no runs`
                : `${p.day} · ${p.runs} run${p.runs === 1 ? '' : 's'} · ${Math.round(v)} tok/run · ${p.lookups ? Math.round(p.cacheHits / p.lookups * 100) : 0}% from memory`}>
              <div style={{
                height: idle ? '2px' : `${pct}%`,
                borderRadius: 3,
                // A free day is the win, so it keeps the memory colour. An idle day is a
                // faint rule, so absence never reads as "cost nothing".
                background: idle ? 'var(--sep)' : v === 0 ? 'var(--cache)' : 'var(--accent)',
                opacity: idle ? 0.7 : 1,
              }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, fontSize: 11, color: 'var(--text-3)' }} className="num">
        <span>{series[0]?.day.slice(5)}</span>
        <span>{series[series.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}

/* CostChart (one bar per recent run) was replaced by HistoryChart above. It could not
   show a trend: a busy day and a quiet day took the same width, so the curve's shape
   depended on how often you happened to run tests rather than on what they cost. */

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
  const [history, setHistory] = uSu<HistoryPoint[] | null>(null);
  const [members, setMembers] = uSu<Member[] | null>(null);
  // Holds the raw key from a creation, for the one sheet that ever displays it.
  const [newKey, setNewKey] = uSu<string | null>(null);
  // null = still loading; [] = loaded and genuinely empty. The empty state must not
  // flash "No API keys yet" before the request comes back.
  const [keys, setKeys] = uSu<ApiKey[] | null>(null);
  const [creating, setCreating] = uSu(false);
  const [confirmRevoke, setConfirmRevoke] = uSu<ApiKey | null>(null);
  const [newDesc, setNewDesc] = uSu('');
  const [newScope, setNewScope] = uSu<'read_only' | 'execute' | 'admin'>('execute');
  const [busyKey, setBusyKey] = uSu(false);

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
    fetch(`/api/proxy/tenants/${tenantId}/usage/history?days=30`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => setHistory(b.series ?? []))
      .catch(() => setHistory([]));   // needs admin; an empty curve is honest for other roles
  }, [tenantId]);

  // Oldest → newest so the chart reads left to right like a timeline.
  const costed = runs.filter((r) => r.totalTokens != null).slice().reverse();
  const free = costed.filter((r) => r.totalTokens === 0).length;
  /* Trend over the 30-day series, measured only across days that actually had runs -
     an idle stretch is not a cost improvement, and counting it as one would be the
     chart flattering itself. */
  const activeDays = (history ?? []).filter((p) => p.runs > 0);
  const perRunOn = (p: HistoryPoint) => p.tokens / p.runs;
  const firstActive = activeDays.length ? perRunOn(activeDays[0]) : 0;
  const lastActive = activeDays.length ? perRunOn(activeDays[activeDays.length - 1]) : 0;
  const histMax = Math.max(0, ...activeDays.map(perRunOn));
  const cheaper = activeDays.length > 1 && firstActive > 0
    ? Math.round((1 - lastActive / firstActive) * 100)
    : null;

  const loadKeys = uCu(async () => {
    if (!tenantId) return;
    try {
      const r = await fetch(`/api/proxy/tenants/${tenantId}/keys`, { cache: 'no-store' });
      if (!r.ok) throw new Error();
      setKeys((await r.json()).keys ?? []);
    } catch {
      setKeys([]);   // listing needs admin; an empty table is honest for other roles
    }
  }, [tenantId]);

  uEu(() => { if (tab === 'keys') loadKeys(); }, [tab, loadKeys]);

  async function createKey() {
    if (!tenantId) return;
    setBusyKey(true);
    try {
      const r = await fetch(`/api/proxy/tenants/${tenantId}/keys`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: newDesc.trim() || undefined, scope: newScope }),
      });
      if (r.status === 403) {
        const b = await r.json().catch(() => ({}));
        // The owner-only gate on admin scope is a real rule, not a failure — say which.
        showToast(b?.error === 'OWNER_REQUIRED'
          ? 'Only the workspace owner can create an admin key'
          : 'You need admin rights to create a key', 'error');
        return;
      }
      if (!r.ok) throw new Error();
      const b = await r.json();
      setCreating(false);
      setNewDesc('');
      setNewScope('execute');
      setNewKey(b.rawKey);   // shown once — the sheet below is the only place it exists
      loadKeys();
    } catch {
      showToast('Could not create that key', 'error');
    } finally {
      setBusyKey(false);
    }
  }

  async function revokeKey(k: ApiKey) {
    if (!tenantId) return;
    try {
      const r = await fetch(`/api/proxy/tenants/${tenantId}/keys/${k.id}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error();
      showToast(`Revoked “${k.description || 'Untitled key'}” — it stops working now`, 'success');
      loadKeys();
    } catch {
      showToast('Could not revoke that key', 'error');
    }
  }

  return (
    <>
      <Toolbar title="Usage" sub={user?.email ? `Signed in as ${user.email}` : 'Workspace'}>
        <Seg value={tab} onChange={setTab} options={[
          { value: 'usage', label: 'Usage' }, { value: 'keys', label: 'API keys' },
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
                {usage && usage.budgetTokensMonthly > 0 && (
                  <span className="num" style={{ fontSize: 15, color: 'var(--text-3)' }}>
                    of {fmt.n(usage.budgetTokensMonthly)}
                  </span>
                )}
                <span style={{ fontSize: 13, color: 'var(--text-3)' }}>spent on finding elements</span>
              </div>
              {usage && <QuotaMeter usage={usage} />}
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
                  <div className="card-t">Tokens per run · last 30 days</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                    The line that matters: a mature test should cost close to nothing.
                  </div>
                </div>
                {cheaper != null && cheaper > 0 && (
                  <span className="badge" style={{ background: 'var(--pass-soft)', color: 'var(--pass)', height: 22, flex: 'none' }}>
                    <I.arrowDown size={10} />{cheaper}% SINCE {activeDays[0].day.slice(5)}
                  </span>
                )}
              </div>
              {history === null ? (
                <div style={{ padding: '34px 0 6px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>
                  Loading 30 days…
                </div>
              ) : !activeDays.length ? (
                <div style={{ padding: '34px 0 6px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>
                  Run a test and the cost curve starts here.
                </div>
              ) : histMax === 0 ? (
                /* A chart of all-zeroes reads as broken, not as the win it is. */
                <div style={{ display: 'flex', gap: 11, alignItems: 'center', marginTop: 14, padding: '14px 15px', background: 'var(--cache-soft)', borderRadius: 9 }}>
                  <I.db size={16} style={{ color: 'var(--cache)', flex: 'none' }} />
                  <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
                    Every run in the last 30 days cost <span className="num" style={{ fontWeight: 600, color: 'var(--cache)' }}>0</span> tokens —
                    every element came from memory. There&rsquo;s no curve to plot until something needs the AI again.
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ marginTop: 15 }}><HistoryChart series={history} /></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: 'var(--text-3)' }} className="num">
                    <span>{fmt.n(Math.round(firstActive))} tok/run on {activeDays[0].day.slice(5)}</span>
                    <span>{fmt.n(Math.round(lastActive))} tok/run on {activeDays[activeDays.length - 1].day.slice(5)}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {tab === 'keys' && (
          <div style={{ maxWidth: 720 }}>
            <div className="card" style={{ padding: 17 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="card-t">API keys</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.55 }}>
                    For CI and scripts. Give each pipeline its own key with the narrowest scope it needs —
                    revoking one never affects the others. Only the hash is stored, so a key is shown once
                    and can&rsquo;t be recovered afterwards.
                  </div>
                </div>
                <button className="btn pri" style={{ flex: 'none' }} onClick={() => setCreating(true)}>
                  <I.plus size={13} />New key
                </button>
              </div>
            </div>

            <div className="list" style={{ marginTop: 14 }}>
              <div className="list-h">
                <span style={{ flex: 1 }}>KEY</span>
                <span style={{ width: 96 }}>SCOPE</span>
                <span className="hide-md" style={{ width: 96, textAlign: 'right' }}>LAST USED</span>
                <span style={{ width: 90, textAlign: 'right' }}>CREATED</span>
                <span style={{ width: 30 }} />
              </div>
              {(keys ?? []).map((k) => {
                const expired = !!k.expiresAt && new Date(k.expiresAt) < new Date();
                return (
                  <div className="row" key={k.id} style={{ cursor: 'default' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row-t">{k.description || 'Untitled key'}</div>
                      <div className="row-s num">{k.keyPrefix}…{expired ? ' · expired' : ''}</div>
                    </div>
                    <span style={{ width: 96, flex: 'none' }}>
                      <span className="badge" style={{
                        background: k.scope === 'admin' ? 'var(--warn-soft)' : 'var(--fill)',
                        color: k.scope === 'admin' ? 'var(--warn)' : 'var(--text-2)',
                      }}>{k.scope.replace('_', ' ')}</span>
                    </span>
                    <span className="num hide-md" style={{ width: 96, flex: 'none', textAlign: 'right', fontSize: 11.5, color: 'var(--text-3)' }}>
                      {/* "never" is the useful signal here: a key nothing uses should be revoked. */}
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'never'}
                    </span>
                    <span className="num" style={{ width: 90, flex: 'none', textAlign: 'right', fontSize: 11.5, color: 'var(--text-3)' }}>
                      {new Date(k.createdAt).toLocaleDateString()}
                    </span>
                    <span style={{ width: 30, flex: 'none', display: 'grid', placeItems: 'center' }}>
                      <button className="btn icon" title="Revoke this key" onClick={() => setConfirmRevoke(k)}>
                        <I.trash size={13} />
                      </button>
                    </span>
                  </div>
                );
              })}
              {keys && !keys.length && (
                <div style={{ padding: '34px 16px', textAlign: 'center' }}>
                  <I.keys size={20} style={{ color: 'var(--text-3)' }} />
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 8 }}>No API keys yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3 }}>
                    Create one to trigger runs from CI.
                  </div>
                </div>
              )}
              {keys === null && (
                <div style={{ padding: '30px 16px', textAlign: 'center', fontSize: 13, color: 'var(--text-3)' }}>Loading keys…</div>
              )}
            </div>
            <div className="card" style={{ marginTop: 14, padding: 15 }}>
              <div className="label">Trigger a run from CI</div>
              {/* The previous snippet sent X-API-Key with a {"caseId"} body. Neither is
                  real: requireApiKey reads Authorization: Bearer, and POST /runs takes
                  {steps, baseUrl}. POST /cases/:id/run is deliberately NOT shown — it
                  sits behind requireAuth (JWT only), so an API key gets 401 there.
                  Verified against a live execute-scoped key. */}
              <pre className="num scroll" style={{ margin: '8px 0 0', fontSize: 12, background: 'var(--fill)', padding: '11px 13px', borderRadius: 8, lineHeight: 1.65, overflowX: 'auto' }}>{`curl -X POST $KAIZEN_API/runs \\
  -H "Authorization: Bearer $KAIZEN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"baseUrl":"https://staging.example.com",
       "steps":["navigate to https://staging.example.com",
                "click Sign in"]}'`}</pre>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 9, lineHeight: 1.5 }}>
                Needs <strong>execute</strong> scope or higher — a read-only key is refused with 403.
                Running a <em>saved</em> test by id still requires a signed-in session rather than a
                key; until that changes, send the steps with the request.
              </div>
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

      {confirmRevoke && (
        <ConfirmSheet title={`Revoke “${confirmRevoke.description || 'Untitled key'}”?`}
          message="Anything still using this key stops working immediately. Other keys in this workspace are unaffected."
          confirmLabel="Revoke key"
          dismissLabel="Keep it"
          onConfirm={() => revokeKey(confirmRevoke)}
          onClose={() => setConfirmRevoke(null)} />
      )}

      {creating && (
        <Sheet title="New API key" width={460} onClose={() => setCreating(false)} footer={
          <>
            <button className="btn lg" onClick={() => setCreating(false)}>Cancel</button>
            <button className="btn pri lg" disabled={busyKey} onClick={createKey}>
              {busyKey ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <I.keys size={13} />}Create key
            </button>
          </>
        }>
          <div className="label">What is it for?</div>
          <input className="field" style={{ width: '100%', marginTop: 5 }} value={newDesc} maxLength={120}
            placeholder="GitHub Actions — main" onChange={(e) => setNewDesc(e.target.value)} />

          <div className="label" style={{ marginTop: 14 }}>What may it do?</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {([
              ['read_only', 'Read only', 'Read tests, runs and results. Cannot start anything.'],
              ['execute', 'Execute', 'Everything above, plus trigger runs. What CI usually needs.'],
              ['admin', 'Admin', 'Full workspace control, including creating more keys. Owner only.'],
            ] as const).map(([value, label, help]) => (
              <button key={value} className="menu-item" onClick={() => setNewScope(value)}
                style={{
                  alignItems: 'flex-start', padding: '9px 11px', borderRadius: 9,
                  background: newScope === value ? 'var(--accent-soft)' : 'var(--fill)',
                  border: `1px solid ${newScope === value ? 'var(--accent)' : 'transparent'}`,
                }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: newScope === value ? 'var(--accent-text)' : 'var(--text)' }}>{label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2, lineHeight: 1.45 }}>{help}</div>
                </div>
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.5 }}>
            The key is shown once on the next screen. Only its hash is stored, so it can&rsquo;t be
            recovered later — if you lose it, revoke it and make another.
          </div>
        </Sheet>
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
