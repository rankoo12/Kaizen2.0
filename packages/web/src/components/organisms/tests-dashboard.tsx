'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, Play, RotateCw, Search as SearchIcon, ChevronDown, Filter, GitCompare,
  LayoutGrid, List as ListIcon, Loader2, Archive, Beaker,
} from 'lucide-react';
import type { CaseSummary, RunStatus, Suite } from '@/types/api';
import { useSuites } from '@/hooks/use-suites';
import { useAllCases } from '@/hooks/use-all-cases';
import { useRunPoller } from '@/hooks/use-run-poller';
import { TopBar } from '@/components/organisms/app-shell/top-bar';
import { StatusDot, type StatusKind } from '@/components/atoms/status-dot';
import { Wip } from '@/components/atoms/wip';
import { Kbd } from '@/components/atoms/kbd';
import { Toast } from '@/components/atoms/toast';
import { cn } from '@/lib/cn';

type FilterKey = 'all' | 'passed' | 'failed' | 'healed';
type ViewMode = 'grid' | 'list';

// ─── Page ────────────────────────────────────────────────────────────────────

export function TestsDashboard() {
  const router = useRouter();
  const { suites, isLoading: suitesLoading } = useSuites();
  const { bySuite, all: allCases, isLoading: casesLoading } = useAllCases(suites);

  const [filter, setFilter]     = useState<FilterKey>('all');
  const [search, setSearch]     = useState('');
  const [view, setView]         = useState<ViewMode>('grid');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning]   = useState<Map<string, string>>(new Map()); // caseId → runId
  const [overrides, setOverrides] = useState<Map<string, RunStatus>>(new Map());
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'success' | 'danger' } | null>(null);

  const showToast = useCallback((msg: string, kind: 'info' | 'success' | 'danger' = 'info') => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const handleRunComplete = useCallback((caseId: string, status: RunStatus) => {
    setRunning((prev) => {
      const next = new Map(prev);
      next.delete(caseId);
      return next;
    });
    setOverrides((prev) => new Map(prev).set(caseId, status));
    showToast(
      `Run ${status.toUpperCase()}.`,
      status === 'failed' ? 'danger' : status === 'passed' ? 'success' : 'info',
    );
  }, [showToast]);

  const runCase = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/proxy/cases/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 402 && body?.message) {
          showToast(body.message, 'danger');
          return;
        }
        throw new Error('failed');
      }
      const { runId } = (await res.json()) as { runId: string };
      setRunning((prev) => new Map(prev).set(id, runId));
    } catch {
      showToast('Failed to enqueue run.', 'danger');
    }
  }, [showToast]);

  const runSelected = useCallback(() => {
    const ids = Array.from(selected);
    if (!ids.length) return;
    showToast(`Queued ${ids.length} test${ids.length === 1 ? '' : 's'}.`);
    ids.forEach(runCase);
    setSelected(new Set());
  }, [selected, runCase, showToast]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar crumbs={[{ label: 'Tests' }]} />

      <PageHeader
        suiteCount={suites.length}
        cases={allCases}
        running={running}
        overrides={overrides}
        onNew={() => router.push('/tests/new')}
        onSync={() => showToast('Sync from main not wired yet.', 'info')}
      />

      <ControlsBar
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        view={view}
        onView={setView}
        onCompare={() => showToast('Compare runs not wired yet.', 'info')}
      />

      <div className="flex-1 overflow-auto px-7 pt-5 pb-20 relative">
        {suitesLoading || casesLoading ? (
          <LoadingState />
        ) : suites.length === 0 ? (
          <EmptyState />
        ) : (
          suites.map((suite) => (
            <SuiteSection
              key={suite.id}
              suite={suite}
              cases={bySuite[suite.id] ?? []}
              search={search}
              filter={filter}
              view={view}
              selected={selected}
              running={running}
              overrides={overrides}
              onToggle={toggleSelect}
              onOpen={(id) => router.push(`/tests/${id}`)}
            />
          ))
        )}
      </div>

      {selected.size > 0 && (
        <SelectionBar
          count={selected.size}
          onClear={() => setSelected(new Set())}
          onArchive={() => showToast('Archive not wired yet.', 'info')}
          onRun={runSelected}
        />
      )}

      {/* Run watchers — one per active run */}
      {Array.from(running.entries()).map(([caseId, runId]) => (
        <RunWatcher key={runId} caseId={caseId} runId={runId} onComplete={handleRunComplete} />
      ))}

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}

// ─── Run watcher (zero-render, owns one poller) ──────────────────────────────

function RunWatcher({
  caseId, runId, onComplete,
}: {
  caseId: string;
  runId: string;
  onComplete: (caseId: string, status: RunStatus) => void;
}) {
  useRunPoller({
    runId,
    onComplete: (r) => onComplete(caseId, r.status),
  });
  return null;
}

// ─── Page header ─────────────────────────────────────────────────────────────

function PageHeader({
  suiteCount, cases, running, overrides, onNew, onSync,
}: {
  suiteCount: number;
  cases: CaseSummary[];
  running: Map<string, string>;
  overrides: Map<string, RunStatus>;
  onNew: () => void;
  onSync: () => void;
}) {
  const testCount = cases.length;
  return (
    <div className="px-7 pt-5 pb-4 border-b border-border-subtle">
      <div className="flex items-end justify-between gap-6 mb-4">
        <div>
          <div className="eyebrow mb-1.5 flex items-center gap-2">
            <span>{testCount} test{testCount === 1 ? '' : 's'}</span>
            <span className="text-text-faint">·</span>
            <span>{suiteCount} suite{suiteCount === 1 ? '' : 's'}</span>
            <span className="text-text-faint">·</span>
            <Wip label="LAST SWEEP WIP" />
          </div>
          <h1 className="font-display text-[28px] font-semibold tracking-tight text-text-hi mb-1 leading-none">
            Tests
          </h1>
          <p className="text-[13px] text-text-mid">
            Plain-English specs that drive a real browser. Healing on.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onSync}
            className={cn(
              'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md cursor-pointer',
              'bg-surface-elevated border border-border-strong text-[13px] text-text font-medium',
              'hover:border-text-faint hover:text-text-hi transition-colors',
            )}
          >
            <RotateCw size={13} /> Sync from main
          </button>
          <button
            onClick={onNew}
            className={cn(
              'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md cursor-pointer',
              'bg-brand-primary text-app-bg-deep text-[13px] font-semibold',
              'border border-brand-primary',
              'hover:brightness-110 transition-all',
            )}
            style={{ boxShadow: '0 0 0 1px var(--color-brand-primary), inset 0 1px 0 rgba(255,255,255,0.15)' }}
          >
            <Plus size={13} /> New test
          </button>
        </div>
      </div>

      <SummaryStrip cases={cases} running={running} overrides={overrides} />
    </div>
  );
}

// ─── Summary strip — pass-rate ring + four cells ─────────────────────────────
// Aggregates computed client-side from the loaded case list. "24h" framing is
// nominal — we don't filter by time yet (no run-history endpoint), so values
// reflect each test's most recent run regardless of when it ran.

function SummaryStrip({
  cases, running, overrides,
}: {
  cases: CaseSummary[];
  running: Map<string, string>;
  overrides: Map<string, RunStatus>;
}) {
  const stats = useMemo(() => {
    let passing = 0, failing = 0, healed = 0;
    const durations: number[] = [];
    for (const c of cases) {
      const status = effectiveStatus(c, running, overrides);
      if (status === 'passed') passing++;
      else if (status === 'failed') failing++;
      else if (status === 'healed') healed++;
      if (c.lastRun?.durationMs != null) durations.push(c.lastRun.durationMs);
    }
    const total = cases.length;
    const decided = passing + failing + healed;
    const passPct = decided > 0 ? Math.round((passing / decided) * 100) : null;
    const median = durations.length
      ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]
      : null;
    return { passing, failing, healed, total, passPct, median };
  }, [cases, running, overrides]);

  const fmtMs = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  return (
    <div className="grid grid-cols-[auto_1fr_1fr_1fr_1fr] bg-surface border border-border-subtle rounded-xl overflow-hidden">
      <div className="flex items-center gap-3.5 px-4.5 py-3.5 border-r border-border-subtle min-w-[220px]">
        <PassRing pct={stats.passPct} />
        <div>
          <div className="eyebrow !text-[9px] mb-0.5">pass rate · last run</div>
          <div className="font-display tabular text-[26px] font-semibold text-text-hi leading-none">
            {stats.passPct != null
              ? <>{stats.passPct}<span className="text-[14px] text-text-low font-normal">%</span></>
              : <span className="text-text-faint">—</span>}
          </div>
        </div>
      </div>
      <SummaryCell label="Passing" status="passed" value={stats.passing} />
      <SummaryCell label="Failing" status="failed" value={stats.failing} />
      <SummaryCell label="Self-healed" status="healed" value={stats.healed} />
      <SummaryCell label="Median run" status="info" value={stats.median != null ? fmtMs(stats.median) : '—'} mono />
    </div>
  );
}

function SummaryCell({
  label, status, value, mono = false,
}: {
  label: string;
  status: 'passed' | 'failed' | 'healed' | 'info';
  value: number | string;
  mono?: boolean;
}) {
  return (
    <div className="px-4.5 py-3.5 border-r border-border-subtle last:border-r-0 flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {status !== 'info' && <StatusDot status={status as StatusKind} size={5} />}
        <span className="eyebrow !text-[9px]">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn('tabular text-[22px] font-semibold text-text-hi', mono ? 'font-mono' : 'font-display')}>
          {value}
        </span>
      </div>
    </div>
  );
}

function PassRing({ pct }: { pct: number | null }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const off = pct == null ? c : c * (1 - pct / 100);
  return (
    <svg width={56} height={56} viewBox="0 0 56 56" aria-hidden>
      <circle cx={28} cy={28} r={r} fill="none" stroke="var(--color-border-strong)" strokeWidth={3} />
      {pct != null && (
        <circle
          cx={28} cy={28} r={r} fill="none"
          stroke="var(--color-success)" strokeWidth={3} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off}
          transform="rotate(-90 28 28)"
          style={{ filter: 'drop-shadow(0 0 4px var(--color-success-glow))', transition: 'stroke-dashoffset 0.6s' }}
        />
      )}
    </svg>
  );
}

// ─── Controls bar ────────────────────────────────────────────────────────────

function ControlsBar({
  search, onSearch, filter, onFilter, view, onView, onCompare,
}: {
  search: string;
  onSearch: (v: string) => void;
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  onCompare: () => void;
}) {
  const filterChips: { id: FilterKey; label: string; dot: StatusKind | null }[] = [
    { id: 'all',    label: 'All',    dot: null },
    { id: 'failed', label: 'Failed', dot: 'failed' },
    { id: 'healed', label: 'Healed', dot: 'healed' },
    { id: 'passed', label: 'Passed', dot: 'passed' },
  ];

  return (
    <div className="flex items-center gap-3 px-7 py-2.5 border-b border-border-subtle bg-app-bg">
      <div className="relative flex items-center bg-surface border border-border-subtle rounded-md px-2.5 min-w-[280px]">
        <SearchIcon size={13} className="text-text-low" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Filter by name, id, suite…"
          className="flex-1 bg-transparent border-0 outline-none px-2.5 py-2 text-[13px] text-text placeholder:text-text-faint"
        />
        <Kbd>/</Kbd>
      </div>

      <div className="flex bg-surface border border-border-subtle rounded-md p-0.5">
        {filterChips.map((f) => (
          <button
            key={f.id}
            onClick={() => onFilter(f.id)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-[5px] text-xs font-medium transition-colors cursor-pointer',
              filter === f.id
                ? 'bg-surface-elevated text-text-hi shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                : 'text-text-mid hover:text-text-hi',
            )}
          >
            {f.dot && <StatusDot status={f.dot} size={6} />}
            {f.label}
          </button>
        ))}
      </div>

      <button
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-text-mid hover:text-text-hi cursor-pointer"
        title="Branch selector — not wired"
      >
        <Filter size={12} /> Branch: <Wip />
        <ChevronDown size={11} />
      </button>

      <div className="flex-1" />

      <div className="flex bg-surface border border-border-subtle rounded-md p-0.5">
        {(['grid', 'list'] as ViewMode[]).map((v) => (
          <button
            key={v}
            onClick={() => onView(v)}
            aria-label={`${v} view`}
            className={cn(
              'grid place-items-center px-2.5 py-1 rounded-[5px] transition-colors cursor-pointer',
              view === v
                ? 'bg-surface-elevated text-brand-primary shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                : 'text-text-mid hover:text-text-hi',
            )}
          >
            {v === 'grid' ? <LayoutGrid size={13} /> : <ListIcon size={13} />}
          </button>
        ))}
      </div>

      <button
        onClick={onCompare}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-text-mid hover:text-text-hi cursor-pointer"
      >
        <GitCompare size={12} /> Compare
      </button>
    </div>
  );
}

// ─── Suite section ───────────────────────────────────────────────────────────

function SuiteSection({
  suite, cases, search, filter, view, selected, running, overrides, onToggle, onOpen,
}: {
  suite: Suite;
  cases: CaseSummary[];
  search: string;
  filter: FilterKey;
  view: ViewMode;
  selected: Set<string>;
  running: Map<string, string>;
  overrides: Map<string, RunStatus>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const filtered = useMemo(() => {
    return cases.filter((c) => {
      const status = effectiveStatus(c, running, overrides);
      if (filter !== 'all' && status !== filter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!c.name.toLowerCase().includes(q) && !c.id.includes(q)) return false;
      }
      return true;
    });
  }, [cases, search, filter, running, overrides]);

  const passCount = filtered.filter((c) => effectiveStatus(c, running, overrides) === 'passed').length;
  const passPct = filtered.length ? Math.round((passCount / filtered.length) * 100) : 0;

  if (filtered.length === 0 && search) return null;

  return (
    <section className="mb-7">
      <header className="flex items-center gap-3 mb-2.5 px-0.5">
        <button className="flex items-center gap-2 text-text-hi cursor-pointer" type="button">
          <ChevronDown size={11} className="text-text-low" />
          <span className="text-[13px] font-medium">{suite.name}</span>
        </button>
        <span className="eyebrow">{filtered.length} tests</span>
        {filtered.length > 0 && (
          <span className="eyebrow text-success">{passPct}% pass</span>
        )}
        <div className="flex-1" />
        <button
          className="text-[11px] uppercase tracking-wider text-text-mid hover:text-text-hi px-2 py-1 rounded cursor-pointer"
          title="Run suite — not wired"
        >
          Run suite
        </button>
      </header>

      {view === 'grid' ? (
        <GridView
          cases={filtered}
          selected={selected}
          running={running}
          overrides={overrides}
          onToggle={onToggle}
          onOpen={onOpen}
        />
      ) : (
        <ListView
          cases={filtered}
          selected={selected}
          running={running}
          overrides={overrides}
          onToggle={onToggle}
          onOpen={onOpen}
          suiteName={suite.name}
        />
      )}
    </section>
  );
}

// ─── Grid view — colored squares ─────────────────────────────────────────────

function GridView({
  cases, selected, running, overrides, onToggle, onOpen,
}: {
  cases: CaseSummary[];
  selected: Set<string>;
  running: Map<string, string>;
  overrides: Map<string, RunStatus>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const hovered = hover ? cases.find((c) => c.id === hover.id) : null;

  return (
    <div className="bg-surface border border-border-subtle rounded-xl p-3 relative">
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: 'repeat(auto-fill, 26px)' }}
      >
        {cases.map((tc) => (
          <TestCell
            key={tc.id}
            tc={tc}
            status={effectiveStatus(tc, running, overrides)}
            selected={selected.has(tc.id)}
            running={running.has(tc.id)}
            onClick={() => onToggle(tc.id)}
            onDoubleClick={() => onOpen(tc.id)}
            onHover={(rect) => setHover(rect ? { id: tc.id, x: rect.left + rect.width / 2, y: rect.top } : null)}
          />
        ))}
      </div>
      {hovered && hover && (
        <TestHoverCard
          tc={hovered}
          status={effectiveStatus(hovered, running, overrides)}
          x={hover.x}
          y={hover.y}
        />
      )}
    </div>
  );
}

function TestCell({
  tc, status, selected, running, onClick, onDoubleClick, onHover,
}: {
  tc: CaseSummary;
  status: StatusKind;
  selected: boolean;
  running: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onHover: (rect: DOMRect | null) => void;
}) {
  const tone = cellTone(status);

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onMouseEnter={(e) => onHover(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => onHover(null)}
      title={tc.name}
      className={cn(
        'w-[22px] h-[22px] rounded-[4px] border grid place-items-center cursor-pointer relative',
        'transition-transform duration-150',
        selected ? 'scale-110 z-10' : 'hover:scale-110',
      )}
      style={{
        background: tone.bg,
        borderColor: selected ? 'var(--color-brand-primary)' : tone.border,
        boxShadow: selected ? '0 0 0 1px var(--color-brand-primary), 0 0 12px var(--color-brand-primary-glow)' : undefined,
      }}
    >
      {running ? (
        <span
          className="w-1.5 h-1.5 rounded-full bg-brand-primary animate-orbit"
          style={{ boxShadow: '0 0 8px var(--color-brand-primary-glow)' }}
        />
      ) : (
        <span className="font-mono tabular text-[9px] font-semibold" style={{ color: tone.fg }}>
          {tc.id.slice(-2)}
        </span>
      )}
    </div>
  );
}

function TestHoverCard({ tc, status, x, y }: { tc: CaseSummary; status: StatusKind; x: number; y: number }) {
  const dur = tc.lastRun?.durationMs;
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean }>({
    left: x,
    top: y,
    below: false,
  });

  // Clamp to viewport once we know the card's measured size. Without this, a
  // card hovered near the right edge or top edge of the screen renders clipped.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Card is anchored with translate(-50%, -100% - 12px), so its visual box is
    // [x - rect.width/2, x + rect.width/2] horizontally and
    // [y - rect.height - 12, y - 12] vertically.
    const halfW = rect.width / 2;
    let left = x;
    if (x - halfW < margin) left = halfW + margin;
    else if (x + halfW > vw - margin) left = vw - halfW - margin;

    // Vertical: flip below the cell if there isn't room above.
    const fitsAbove = y - rect.height - 12 >= margin;
    let top = fitsAbove ? y : y + 12 + 22; // 22 ≈ cell height
    if (top + rect.height > vh - margin) top = vh - rect.height - margin;

    setPos({ left, top, below: !fitsAbove });
  }, [x, y]);

  const transform = pos.below
    ? 'translate(-50%, 0)'
    : 'translate(-50%, calc(-100% - 12px))';

  return (
    <div
      ref={cardRef}
      className="animate-modal-pop pointer-events-none fixed z-50 w-[320px] rounded-xl border border-border-strong bg-surface-elevated/95 backdrop-blur-md p-4 shadow-2xl"
      style={{ left: pos.left, top: pos.top, transform }}
    >
      <div className="flex items-start justify-between mb-2.5">
        <div className="flex-1 pr-2">
          <div className="eyebrow !text-[9px] mb-1">#{tc.id.slice(-6)}</div>
          <div className="text-[13px] font-medium text-text-hi leading-tight">{tc.name}</div>
        </div>
        <StatusChip status={status} />
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2.5">
        <Mini label="duration" value={dur ? `${(dur / 1000).toFixed(1)}s` : null} />
        <Mini label="tokens" value={tc.lastRun?.totalTokens?.toLocaleString() ?? null} />
      </div>

      <div className="eyebrow !text-[9px] mb-1.5">last 12 runs</div>
      <div className="h-[18px]"><Wip /></div>

      <div className="mt-3 pt-2.5 border-t border-border-subtle flex justify-between text-[11px]">
        <span className="text-text-low">
          {tc.lastRun?.completedAt
            ? new Date(tc.lastRun.completedAt).toLocaleTimeString()
            : 'Never run'}
        </span>
        <span className="font-mono text-text-mid">{tc.baseUrl}</span>
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="p-2 rounded-md bg-surface-sunken border border-border-subtle">
      <div className="eyebrow !text-[8px] mb-0.5">{label}</div>
      <div className="font-mono tabular text-[13px] text-text-hi font-medium">
        {value ?? <Wip />}
      </div>
    </div>
  );
}

// ─── List view ───────────────────────────────────────────────────────────────

function ListView({
  cases, selected, running, overrides, onToggle, onOpen, suiteName,
}: {
  cases: CaseSummary[];
  selected: Set<string>;
  running: Map<string, string>;
  overrides: Map<string, RunStatus>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  suiteName: string;
}) {
  const cols = '32px 60px 1fr 200px 100px 80px 80px 60px';

  return (
    <div className="bg-surface border border-border-subtle rounded-xl overflow-hidden">
      <div
        className="grid gap-3 px-4 py-2.5 border-b border-border-subtle bg-surface-sunken"
        style={{ gridTemplateColumns: cols }}
      >
        {['', 'id', 'description', 'suite', 'duration', 'tokens', 'last 12', 'when'].map((h) => (
          <div key={h} className="eyebrow !text-[9px]">{h}</div>
        ))}
      </div>
      {cases.map((tc) => {
        const status = effectiveStatus(tc, running, overrides);
        const isSelected = selected.has(tc.id);
        const isRunning = running.has(tc.id);
        const dur = tc.lastRun?.durationMs;
        return (
          <div
            key={tc.id}
            onClick={() => onToggle(tc.id)}
            onDoubleClick={() => onOpen(tc.id)}
            className={cn(
              'grid gap-3 px-4 py-2.5 border-b border-border-subtle items-center cursor-pointer text-xs transition-colors',
              isSelected ? 'bg-brand-primary/5' : 'hover:bg-surface-elevated',
            )}
            style={{ gridTemplateColumns: cols }}
          >
            <div>
              {isRunning ? (
                <Loader2 size={12} className="animate-orbit text-brand-primary" />
              ) : (
                <StatusDot status={status} size={8} />
              )}
            </div>
            <div className="font-mono tabular text-text-low text-[11px]">#{tc.id.slice(-4)}</div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-text-hi font-medium truncate">{tc.name}</span>
              {status === 'healed' && <StatusChip status="healed" small />}
            </div>
            <div className="text-text-mid truncate">{suiteName}</div>
            <div className="font-mono tabular text-text">
              {dur != null ? `${(dur / 1000).toFixed(1)}s` : <Wip />}
            </div>
            <div className="font-mono tabular text-text-mid">
              {tc.lastRun?.totalTokens != null ? tc.lastRun.totalTokens.toLocaleString() : '—'}
            </div>
            <div className="h-[14px]"><Wip /></div>
            <div className="text-text-low text-[11px]">
              {tc.lastRun?.completedAt
                ? `${Math.max(0, Math.round((Date.now() - new Date(tc.lastRun.completedAt).getTime()) / 60000))}m`
                : <Wip />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Selection action bar ────────────────────────────────────────────────────

function SelectionBar({
  count, onClear, onArchive, onRun,
}: { count: number; onClear: () => void; onArchive: () => void; onRun: () => void }) {
  return (
    <div
      className={cn(
        'animate-modal-pop',
        'absolute bottom-6 left-1/2 -translate-x-1/2 z-50',
        'flex items-center gap-3 px-3.5 py-2.5',
        'rounded-xl border border-border-strong bg-surface-elevated/92 backdrop-blur-md',
        'shadow-2xl',
      )}
    >
      <div
        className="w-7 h-7 rounded-lg grid place-items-center text-app-bg-deep font-bold text-xs font-mono tabular"
        style={{
          background: 'var(--color-brand-primary)',
          boxShadow: '0 0 12px var(--color-brand-primary-glow)',
        }}
      >
        {count}
      </div>
      <span className="text-xs text-text-hi font-medium">
        {count} test{count === 1 ? '' : 's'} selected
      </span>
      <span className="w-px h-4 bg-border-subtle" />
      <button onClick={onClear} className="text-xs text-text-mid hover:text-text-hi px-2 py-1 cursor-pointer">Clear</button>
      <button
        onClick={onArchive}
        className="inline-flex items-center gap-1.5 text-xs text-text-mid hover:text-text-hi px-2 py-1 rounded-md border border-border-strong bg-surface-elevated cursor-pointer"
      >
        <Archive size={12} /> Archive
      </button>
      <button
        onClick={onRun}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-app-bg-deep px-3 py-1.5 rounded-md bg-brand-primary cursor-pointer"
        style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15), 0 0 12px var(--color-brand-primary-glow)' }}
      >
        <Play size={11} /> Run {count}
      </button>
    </div>
  );
}

// ─── Status chip ─────────────────────────────────────────────────────────────

function StatusChip({ status, small = false }: { status: StatusKind; small?: boolean }) {
  const tone: Record<StatusKind, string> = {
    passed:  'text-success border-success/25 bg-success/10',
    failed:  'text-danger border-danger/30 bg-danger/10',
    healed:  'text-brand-accent border-brand-accent/30 bg-brand-accent/10',
    running: 'text-brand-primary border-border-accent bg-surface-elevated',
    queued:  'text-warning border-warning/30 bg-warning/10',
    pending: 'text-text-low border-border-subtle bg-surface-sunken',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-mono uppercase font-semibold tracking-[0.12em] shrink-0',
        small ? 'text-[9px] px-1.5 py-px' : 'text-[10px] px-2 py-0.5',
        tone[status],
      )}
    >
      <StatusDot status={status} size={small ? 5 : 6} />
      {status}
    </span>
  );
}

// ─── States ──────────────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 text-text-low">
      <Loader2 size={28} className="animate-orbit" />
      <span className="eyebrow">initializing suites</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3 text-text-low">
      <Beaker size={36} className="opacity-50" />
      <p className="text-sm">No suites yet. Start by creating a new test.</p>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function effectiveStatus(
  tc: CaseSummary,
  running: Map<string, string>,
  overrides: Map<string, RunStatus>,
): StatusKind {
  if (running.has(tc.id)) return 'running';
  const override = overrides.get(tc.id);
  if (override) return statusToKind(override);
  if (tc.lastRun?.status) return statusToKind(tc.lastRun.status);
  return 'pending';
}

function statusToKind(s: RunStatus): StatusKind {
  if (s === 'cancelled') return 'pending';
  return s as StatusKind;
}

function cellTone(status: StatusKind): { bg: string; border: string; fg: string } {
  switch (status) {
    case 'passed':  return { bg: 'rgba(34, 197, 94, 0.08)',  border: 'rgba(34, 197, 94, 0.18)',  fg: 'var(--color-success)' };
    case 'failed':  return { bg: 'rgba(239, 68, 68, 0.10)',  border: 'rgba(239, 68, 68, 0.30)',  fg: 'var(--color-danger)' };
    case 'healed':  return { bg: 'rgba(219, 135, 175, 0.10)', border: 'rgba(219, 135, 175, 0.25)', fg: 'var(--color-brand-accent)' };
    case 'running': return { bg: 'rgba(213, 96, 28, 0.10)',  border: 'var(--color-border-accent)', fg: 'var(--color-brand-primary)' };
    case 'queued':  return { bg: 'rgba(245, 158, 11, 0.10)', border: 'rgba(245, 158, 11, 0.30)', fg: 'var(--color-warning)' };
    default:        return { bg: 'var(--color-surface-sunken)', border: 'var(--color-border-subtle)', fg: 'var(--color-text-low)' };
  }
}
