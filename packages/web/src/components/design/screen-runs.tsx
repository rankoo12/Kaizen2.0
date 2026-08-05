'use client';
/* Runs — design markup from `Kaizen (1)/native/screen-runs.jsx`, reading the real
   per-tenant feed (GET /runs?page&limit). Header stats are computed from the runs
   actually loaded and labelled that way — the design said "today", which the endpoint
   doesn't scope to. Refreshes every 4s while anything is queued or running. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I, StatusBadge } from './icons';
import { Toolbar, Seg, Stat } from './chrome';
import { fmt } from './data';
import { useAuth } from '@/context/auth-context';
import type { RunSummary } from '@/types/api';

const { useState: uSf, useEffect: uEf, useCallback: uCf } = React;

const PAGE_SIZE = 50;

function relWhen(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d === 1) return 'yesterday'; if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Host of the URL this run executed against. The full URL is too long for a list row,
 *  and the host is the part that answers "which environment was this?". */
function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

export function RunsScreen({ onOpen }: { onOpen: (r: RunSummary) => void }) {
  const { user } = useAuth();
  const [runs, setRuns] = uSf<RunSummary[]>([]);
  const [total, setTotal] = uSf(0);
  const [loading, setLoading] = uSf(true);
  const [f, setF] = uSf('all');

  const load = uCf(async () => {
    try {
      const r = await fetch(`/api/proxy/runs?limit=${PAGE_SIZE}`, { cache: 'no-store' });
      if (!r.ok) throw new Error();
      const b = await r.json();
      setRuns(b.runs ?? []);
      setTotal(b.total ?? 0);
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  uEf(() => { if (user?.id) load(); }, [user?.id, load]);

  const active = runs.filter((r) => r.status === 'running' || r.status === 'queued').length;

  // Keep the feed live while something is in flight — same 2s cadence the run screen
  // polls at, halved to 4s because this is a whole-workspace list.
  uEf(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      load();
    }, 4000);
    return () => window.clearInterval(id);
  }, [active, load]);

  const list = runs.filter((r) => f === 'all'
    || (f === 'active' ? r.status === 'running' || r.status === 'queued' : r.status === f));
  const tokens = runs.reduce((a, r) => a + (r.totalTokens ?? 0), 0);

  return (
    <>
      <Toolbar title="Runs" sub={total ? `${total} run${total === 1 ? '' : 's'} in this workspace, newest first` : 'Every execution in this workspace, newest first'}>
        {active > 0 && (
          <span className="pill" style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>
            <span className="dot pulse" style={{ background: 'var(--accent)', width: 6, height: 6 }} />{active} active
          </span>
        )}
        <Seg value={f} onChange={setF} options={[
          { value: 'all', label: 'All' }, { value: 'active', label: 'Active' },
          { value: 'failed', label: 'Failed' }, { value: 'healed', label: 'Healed' },
        ]} />
        <button className="btn icon" title="Refresh" onClick={load}><I.runs size={14} /></button>
      </Toolbar>
      <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px' }}>
        <div className="card rise" style={{ display: 'flex', marginBottom: 16, overflow: 'hidden', flexWrap: 'wrap' }}>
          {([
            ['RUNS SHOWN', runs.length, null, total > runs.length ? `of ${total} total` : 'all of them'],
            ['PASSED CLEAN', runs.filter((r) => r.status === 'passed').length, 'var(--pass)', 'no healing needed'],
            ['SELF-HEALED', runs.filter((r) => r.status === 'healed').length, 'var(--heal)', 'passed anyway'],
            ['FAILED', runs.filter((r) => r.status === 'failed').length, 'var(--fail)', 'need a look'],
            ['TOKENS', fmt.k(tokens), tokens ? 'var(--warn)' : 'var(--cache)', 'across these runs'],
          ] as any[]).map(([l, v, tone, sub], i, arr) => (
            <div key={l} className={i === 0 ? 'hide-md' : undefined} style={{ flex: '1 1 148px', minWidth: 0, borderRight: i < arr.length - 1 ? '.5px solid var(--sep)' : 'none' }}>
              <Stat label={l} value={v} tone={tone} sub={sub} />
            </div>
          ))}
        </div>

        <div className="list">
          <div className="list-h">
            <span style={{ flex: 1 }}>TEST</span><span style={{ width: 84 }}>STATUS</span>
            <span className="hide-lg" style={{ width: 80, textAlign: 'right' }}>DURATION</span>
            <span style={{ width: 80, textAlign: 'right' }}>TOKENS</span>
            <span className="hide-md" style={{ width: 78 }}>TRIGGER</span>
            <span style={{ width: 70, textAlign: 'right' }}>WHEN</span><span style={{ width: 22 }} />
          </div>
          {list.map((r) => {
            const live = r.status === 'running' || r.status === 'queued';
            const host = hostOf(r.environmentUrl);
            // Progress needs a denominator the run itself owns. totalSteps is stamped at
            // enqueue; it's null only for runs that predate migration 028 and had nothing
            // to backfill from, and those show the old text rather than a fake meter.
            const done = r.completedSteps ?? 0;
            const showMeter = live && r.totalSteps != null && r.totalSteps > 0;
            const pct = showMeter ? Math.min(100, (done / (r.totalSteps as number)) * 100) : 0;
            return (
              <div className="row" key={r.id} onClick={() => onOpen(r)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row-t" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span title={r.caseName ?? undefined} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.caseName ?? 'Deleted test'}
                    </span>
                    <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>#{r.id.slice(0, 8)}</span>
                  </div>
                  {live
                    ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <span className="spinner" style={{ width: 11, height: 11 }} />
                        <span style={{ fontSize: 11, color: 'var(--accent-text)', whiteSpace: 'nowrap' }}>
                          {r.status === 'queued'
                            ? 'waiting for a browser'
                            : showMeter ? `step ${Math.min(done + 1, r.totalSteps as number)} of ${r.totalSteps}` : 'running · polling'}
                        </span>
                        {showMeter && (
                          <span className="meter" style={{ flex: '0 1 120px', minWidth: 40 }}>
                            <i style={{ width: `${pct}%` }} />
                          </span>
                        )}
                      </div>
                    : <div className="row-s">
                        {r.suiteName ?? '—'}
                        {host && <><span style={{ margin: '0 6px', color: 'var(--text-3)' }}>·</span><span className="num">{host}</span></>}
                      </div>}
                </div>
                <span style={{ width: 84 }}><StatusBadge status={r.status} size="sm" /></span>
                <span className="num hide-lg" style={{ width: 80, textAlign: 'right', fontSize: 12, color: live ? 'var(--text-3)' : 'var(--text)' }}>
                  {r.durationMs != null ? fmt.ms(r.durationMs) : '—'}
                </span>
                <span className="num" style={{ width: 80, textAlign: 'right', fontSize: 12, color: r.totalTokens === 0 ? 'var(--cache)' : 'var(--text)' }}>
                  {r.totalTokens == null ? '—' : r.totalTokens === 0 ? 'free' : fmt.n(r.totalTokens)}
                </span>
                <span className="hide-md" style={{ width: 78 }}><span className="badge" style={{ background: 'var(--fill)', color: 'var(--text-2)' }}>{(r.triggeredBy || '—').toUpperCase()}</span></span>
                <span className="num" style={{ width: 70, textAlign: 'right', fontSize: 11, color: 'var(--text-2)' }}>{relWhen(r.completedAt || r.createdAt)}</span>
                <span style={{ width: 22, display: 'grid', placeItems: 'center' }}><I.chevron size={12} style={{ color: 'var(--text-3)' }} /></span>
              </div>
            );
          })}
          {!list.length && (
            <div style={{ padding: '44px 16px', textAlign: 'center' }}>
              <I.runs size={22} style={{ color: 'var(--text-3)' }} />
              <div style={{ fontSize: 14, fontWeight: 600, marginTop: 8 }}>
                {loading ? 'Loading runs…' : runs.length ? 'No runs match that filter' : 'No runs yet'}
              </div>
              {!loading && !runs.length && (
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3 }}>Run a test and it shows up here the moment it&rsquo;s queued.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
