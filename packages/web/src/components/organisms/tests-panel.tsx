'use client';

import { useState, useRef, useMemo, useCallback, memo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  GitCompare,
  Plus,
  Archive,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Database,
  Code2,
  Cpu,
  History,
  AlertCircle,
  Loader2,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/cn';

// ─── Types ─────────────────────────────────────────────────────────────────────

type TestStatus = 'Passed' | 'Failed' | 'Pending';

type TestStep = {
  num: string;
  title: string;
  type: string;
  time: string;
  tool: string;
  icon: 'database' | 'code' | 'cpu';
  pass: boolean;
};

type Test = {
  id: number;
  suiteId: string;
  suiteName: string;
  status: TestStatus;
  previousStatus: TestStatus;
  history: TestStatus[];
  tokens: number;
  duration: string;
  description: string;
  rootCause: string | null;
  timestamp: string;
  isArchived: boolean;
  steps: TestStep[];
};

type Suite = {
  id: string;
  name: string;
  testIds: number[];
};

// ─── Mock Data ─────────────────────────────────────────────────────────────────

const SUITES_CONFIG = [
  { id: 'auth', name: 'Authentication Flow Suite', count: 180 },
  { id: 'checkout', name: 'Checkout Process Suite', count: 320 },
  { id: 'dashboard', name: 'User Dashboard Suite', count: 250 },
  { id: 'settings', name: 'Account Settings Suite', count: 250 },
];

function generateMockData(): { tests: Map<number, Test>; suites: Suite[] } {
  const tests = new Map<number, Test>();
  const suites: Suite[] = [];
  let counter = 1;

  SUITES_CONFIG.forEach((cfg) => {
    const ids: number[] = [];
    for (let i = 0; i < cfg.count; i++) {
      const r = Math.random();
      const status: TestStatus = r < 0.85 ? 'Passed' : r < 0.95 ? 'Failed' : 'Pending';
      const rp = Math.random();
      const previousStatus: TestStatus = rp < 0.8 ? 'Passed' : rp < 0.92 ? 'Failed' : 'Pending';
      const history: TestStatus[] = Array.from(
        { length: 5 },
        () => (Math.random() > 0.2 ? 'Passed' : 'Failed') as TestStatus,
      );
      history[4] = status;

      const id = counter++;
      tests.set(id, {
        id,
        suiteId: cfg.id,
        suiteName: cfg.name,
        status,
        previousStatus,
        history,
        tokens: Math.floor(Math.random() * 2000 + 500),
        duration: (Math.random() * 50 + 5).toFixed(1),
        description: `Verify semantic interaction flow #${Math.floor(
          Math.random() * 1000,
        )} within ${cfg.name.toLowerCase()}. Expected robust DOM mapping.`,
        rootCause: status === 'Failed' ? 'Element mismatch detected in Shadow DOM' : null,
        timestamp: new Date(
          Date.now() - Math.floor(Math.random() * 10_000_000),
        ).toLocaleTimeString(),
        isArchived: false,
        steps: [
          {
            num: '001',
            title: 'Database Authentication',
            type: 'LIRSHOM',
            time: '12ms',
            tool: 'Cloud_Sync_01',
            icon: 'database',
            pass: true,
          },
          {
            num: '002',
            title: 'Profile Schema Match',
            type: 'L2 DB EXACT',
            time: '144ms',
            tool: 'JSON_Validator',
            icon: 'code',
            pass: status === 'Passed',
          },
          {
            num: '003',
            title: 'Semantic Logic Validation',
            type: 'LLM RESOLVED',
            time: '1708ms',
            tool: 'GPT-4_Agent',
            icon: 'cpu',
            pass: status === 'Passed',
          },
        ],
      });
      ids.push(id);
    }
    suites.push({ id: cfg.id, name: cfg.name, testIds: ids });
  });

  return { tests, suites };
}

// ─── Step Icon ─────────────────────────────────────────────────────────────────

function StepIcon({ icon }: { icon: string }) {
  if (icon === 'database') return <Database className="w-3 h-3" />;
  if (icon === 'code') return <Code2 className="w-3 h-3" />;
  return <Cpu className="w-3 h-3" />;
}

// ─── Test Square ───────────────────────────────────────────────────────────────

type SquareProps = {
  test: Test;
  isSelected: boolean;
  isRunning: boolean;
  comparisonMode: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onEnter: (e: React.MouseEvent<HTMLDivElement>) => void;
  onLeave: () => void;
};

const TestSquare = memo(function TestSquare({
  test,
  isSelected,
  isRunning,
  comparisonMode,
  onSelect,
  onOpen,
  onEnter,
  onLeave,
}: SquareProps) {
  const isReg = comparisonMode && test.previousStatus === 'Passed' && test.status === 'Failed';
  const isImp = comparisonMode && test.previousStatus === 'Failed' && test.status === 'Passed';
  const isDimmed = comparisonMode && !isReg && !isImp;

  return (
    <div
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpen();
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={cn(
        'w-7 h-7 rounded flex items-center justify-center cursor-pointer transition-all duration-300 ease-out relative',
        // Normal mode colors
        !comparisonMode && test.status === 'Passed' && 'bg-green-500/20 text-green-500 border border-green-500/30',
        !comparisonMode && test.status === 'Failed' && 'bg-brand-red/20 text-brand-red border border-brand-red/30',
        !comparisonMode && test.status === 'Pending' && 'bg-brand-yellow/20 text-brand-yellow border border-brand-yellow/30',
        // Comparison mode: regressions
        isReg && 'bg-brand-red/20 text-brand-red border-2 border-brand-red animate-pulse-red shadow-[0_0_15px_rgba(239,68,68,0.5)] z-10',
        // Comparison mode: improvements
        isImp && 'bg-green-500/20 text-green-500 border-2 border-green-500/50 animate-glow-green shadow-[0_0_15px_rgba(34,197,94,0.3)] z-10',
        // Comparison mode: unchanged (dimmed)
        isDimmed && test.status === 'Passed' && 'bg-green-500/10 text-green-500 opacity-30 hover:opacity-100',
        isDimmed && test.status === 'Failed' && 'bg-brand-red/10 text-brand-red opacity-30 hover:opacity-100',
        isDimmed && test.status === 'Pending' && 'bg-brand-yellow/10 text-brand-yellow opacity-30 hover:opacity-100',
        // Selection state
        isSelected &&
          '!border-2 !border-brand-orange !shadow-[0_0_15px_rgba(213,96,28,0.8)] scale-110 z-20 !opacity-100',
        !isSelected && !comparisonMode && 'hover:scale-110 hover:z-30 hover:border-white/50',
        // Running state
        isRunning && '!border-2 !border-brand-orange/50 shadow-[0_0_10px_rgba(213,96,28,0.3)] opacity-75',
      )}
    >
      {isRunning ? (
        <Loader2 className="w-3 h-3 animate-spin text-brand-orange" />
      ) : (
        <span className="text-[9px] font-mono font-bold pointer-events-none">{test.id}</span>
      )}
    </div>
  );
});

// ─── Main Panel ────────────────────────────────────────────────────────────────

export function TestsPanel() {
  const router = useRouter();

  const [tests, setTests] = useState<Map<number, Test>>(new Map());
  const [suites, setSuites] = useState<Suite[]>([]);

  useEffect(() => {
    const data = generateMockData();
    setSuites(data.suites);
    setTests(data.tests);
  }, []);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [running, setRunning] = useState<Set<number>>(new Set());
  const [comparisonMode, setComparisonMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [quickInput, setQuickInput] = useState('');
  const [modalId, setModalId] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ id: number; x: number; y: number } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Visibility predicate ───────────────────────────────────────────────────

  const isVisible = useCallback(
    (test: Test): boolean => {
      if (test.isArchived) return false;
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        test.description.toLowerCase().includes(q) ||
        !!test.rootCause?.toLowerCase().includes(q) ||
        test.suiteName.toLowerCase().includes(q)
      );
    },
    [searchQuery],
  );

  // ── Derived stats ──────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    let total = 0,
      regressions = 0,
      improvements = 0;
    tests.forEach((t) => {
      if (!isVisible(t)) return;
      total++;
      if (t.previousStatus === 'Passed' && t.status === 'Failed') regressions++;
      if (t.previousStatus === 'Failed' && t.status === 'Passed') improvements++;
    });
    return { total, regressions, improvements };
  }, [tests, isVisible]);

  // ── Toast ──────────────────────────────────────────────────────────────────

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3500);
  }, []);

  // ── Selection ──────────────────────────────────────────────────────────────

  const toggleSelection = useCallback(
    (id: number) => {
      setSelected((prev) => {
        if (running.has(id)) return prev;
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          if (next.size >= 9) {
            showToast('Maximum 9 tests can be selected concurrently.');
            return prev;
          }
          next.add(id);
        }
        return next;
      });
    },
    [running, showToast],
  );

  const handleSmartSelect = useCallback(
    (type: 'failed' | 'regression') => {
      let ids: number[] = [];
      tests.forEach((t) => {
        if (!isVisible(t)) return;
        if (type === 'failed' && t.status === 'Failed') ids.push(t.id);
        if (type === 'regression' && t.previousStatus === 'Passed' && t.status === 'Failed')
          ids.push(t.id);
      });
      if (ids.length > 9) {
        showToast(`Selected first 9 out of ${ids.length} to respect concurrency limit.`);
        ids = ids.slice(0, 9);
      }
      setSelected(new Set(ids));
    },
    [tests, isVisible, showToast],
  );

  // ── Run ────────────────────────────────────────────────────────────────────

  const handleRunSelected = useCallback(() => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    setRunning((prev) => {
      const n = new Set(prev);
      ids.forEach((id) => n.add(id));
      return n;
    });
    setSelected(new Set());
    showToast(`Executing ${ids.length} test${ids.length > 1 ? 's' : ''} concurrently...`);

    ids.forEach((id) => {
      const delay = Math.random() * 3000 + 1500;
      setTimeout(() => {
        const isPass = Math.random() > 0.15;
        setTests((prev) => {
          const next = new Map(prev);
          const t = next.get(id);
          if (t) {
            next.set(id, {
              ...t,
              status: isPass ? 'Passed' : 'Failed',
              timestamp: new Date().toLocaleTimeString(),
              steps: t.steps.map((s, i) => (i === 0 ? s : { ...s, pass: isPass })),
            });
          }
          return next;
        });
        setRunning((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      }, delay);
    });
  }, [selected, showToast]);

  // ── Archive ────────────────────────────────────────────────────────────────

  const handleArchive = useCallback(() => {
    const count = selected.size;
    setTests((prev) => {
      const next = new Map(prev);
      selected.forEach((id) => {
        const t = next.get(id);
        if (t) next.set(id, { ...t, isArchived: true });
      });
      return next;
    });
    setSelected(new Set());
    showToast(`Archived ${count} test${count > 1 ? 's' : ''}.`);
  }, [selected, showToast]);

  // ── Force Pass ─────────────────────────────────────────────────────────────

  const handleForcePass = useCallback(() => {
    if (!modalId || !overrideReason.trim()) return;
    setTests((prev) => {
      const next = new Map(prev);
      const t = next.get(modalId);
      if (t) {
        next.set(modalId, {
          ...t,
          status: 'Passed',
          description: `[OVERRIDDEN: ${overrideReason}] ${t.description}`,
          steps: t.steps.map((s) => ({ ...s, pass: true })),
        });
      }
      return next;
    });
    const id = modalId;
    setModalId(null);
    setOverrideReason('');
    showToast(`Test #${id} force passed.`);
  }, [modalId, overrideReason, showToast]);

  // ── Quick Select ───────────────────────────────────────────────────────────

  const handleQuickSelect = useCallback(
    (e: React.SyntheticEvent<HTMLFormElement>) => {
      e.preventDefault();
      const id = parseInt(quickInput.replace('#', ''), 10);
      if (!id) return;
      const t = tests.get(id);
      if (t && !t.isArchived) {
        toggleSelection(id);
        setQuickInput('');
      } else {
        showToast(`Test #${id} not found or archived.`);
      }
    },
    [quickInput, tests, toggleSelection, showToast],
  );

  // ── Tooltip ────────────────────────────────────────────────────────────────

  const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLDivElement>, id: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ id, x: rect.left + rect.width / 2, y: rect.top });
  }, []);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  // ── Derived refs ───────────────────────────────────────────────────────────

  const modalTest = modalId ? tests.get(modalId) : null;
  const tooltipTest = tooltip ? tests.get(tooltip.id) : null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <main className="p-4 md:p-8 max-w-[1600px] mx-auto w-full flex flex-col gap-6 pb-24">
        {/* ── Header Controls ──────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 bg-card-bg p-6 rounded-2xl border border-border-subtle shadow-lg">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight mb-2">Execution & Analysis</h1>
              <p className="text-brand-pink/80 text-sm">
                Monitoring{' '}
                <span className="font-mono">{stats.total.toLocaleString()}</span> semantic
                validations.
              </p>
            </div>

            <div className="flex flex-col md:flex-row items-center gap-4">
              {/* Smart Selectors */}
              <div className="flex items-center space-x-2 bg-app-bg p-1 rounded-lg border border-border-subtle">
                <button
                  onClick={() => handleSmartSelect('failed')}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-red hover:bg-white/5 rounded transition-colors"
                >
                  All Failed
                </button>
                <div className="w-px h-4 bg-border-subtle" />
                <button
                  onClick={() => handleSmartSelect('regression')}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-orange hover:bg-white/5 rounded transition-colors"
                >
                  Regressions
                </button>
                <div className="w-px h-4 bg-border-subtle" />
                <button
                  onClick={() => setSelected(new Set())}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-400 hover:bg-white/5 rounded transition-colors"
                >
                  Clear
                </button>
              </div>

              {/* Comparison Toggle */}
              <button
                onClick={() => setComparisonMode((v) => !v)}
                className={cn(
                  'px-3 py-2 rounded-lg text-xs font-bold tracking-widest uppercase flex items-center space-x-2 transition-all border',
                  comparisonMode
                    ? 'bg-brand-orange/10 text-brand-orange border-brand-orange/50'
                    : 'bg-app-bg text-gray-400 border-border-subtle hover:border-white/30 hover:text-white',
                )}
                title="Toggle Regression Analysis"
              >
                <GitCompare className="w-3.5 h-3.5" />
                <span>Compare</span>
              </button>

              {/* Add New Test */}
              <button
                onClick={() => router.push('/tests/new')}
                className="px-5 py-2.5 bg-brand-orange text-black text-sm font-bold tracking-widest uppercase rounded-xl hover:scale-105 transition-transform flex items-center space-x-2 shadow-[0_0_15px_rgba(213,96,28,0.4)]"
              >
                <Plus className="w-4 h-4" />
                <span>Add New Test</span>
              </button>
            </div>
          </div>

          {/* Search + Quick Select row */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1 group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 transition-colors" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter by description, root cause, suite..."
                className="w-full bg-app-bg border border-border-subtle rounded-full py-2 pl-10 pr-4 text-sm text-white outline-none focus:border-brand-orange/50 transition-all"
              />
            </div>
            <form onSubmit={handleQuickSelect} className="relative">
              <input
                type="text"
                value={quickInput}
                onChange={(e) => setQuickInput(e.target.value)}
                placeholder="ID (e.g. #42)"
                className="w-32 bg-app-bg border border-border-subtle rounded-full py-2 px-4 text-sm text-center text-white outline-none focus:border-brand-orange/50 font-mono transition-all"
              />
            </form>
          </div>
        </div>

        {/* ── Comparison Legend ─────────────────────────────────────────────── */}
        {comparisonMode && (
          <div className="bg-card-bg/80 border border-brand-orange/30 p-4 rounded-xl flex items-center justify-between shadow-lg animate-modal-pop">
            <div className="flex items-center space-x-3">
              <History className="w-5 h-5 text-brand-orange" />
              <span className="text-sm font-bold text-white tracking-widest">
                BASELINE: Last Successful Run (2 hrs ago)
              </span>
            </div>
            <div className="flex items-center space-x-6 text-xs font-bold tracking-widest uppercase">
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 border-2 border-brand-red shadow-[0_0_10px_rgba(239,68,68,0.5)]" />
                <span className="text-brand-red">
                  <span className="font-mono">{stats.regressions}</span> Regressions
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 bg-green-500/20 border-2 border-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.3)]" />
                <span className="text-green-500">
                  <span className="font-mono">{stats.improvements}</span> Improvements
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ── Suites Grid ───────────────────────────────────────────────────── */}
        <div className="bg-card-bg p-5 rounded-2xl border border-border-subtle shadow-lg min-h-[500px]">
          <div className="flex flex-col gap-8 max-h-[600px] overflow-y-auto pr-2">
            {suites.map((suite) => {
              const visibleIds = suite.testIds.filter((id) => {
                const t = tests.get(id);
                return t && isVisible(t);
              });
              if (visibleIds.length === 0) return null;

              return (
                <div key={suite.id} className="flex flex-col space-y-3">
                  <div className="text-[11px] font-bold text-gray-400 tracking-wider uppercase flex justify-between items-center sticky top-0 bg-card-bg py-2 z-10 border-b border-border-subtle">
                    <span>{suite.name}</span>
                    <span className="text-gray-600 bg-white/5 px-2 py-1 rounded font-mono">
                      {visibleIds.length} Tests
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {visibleIds.map((id) => {
                      const test = tests.get(id)!;
                      return (
                        <TestSquare
                          key={id}
                          test={test}
                          isSelected={selected.has(id)}
                          isRunning={running.has(id)}
                          comparisonMode={comparisonMode}
                          onSelect={() => toggleSelection(id)}
                          onOpen={() => {
                            setModalId(id);
                            setOverrideReason('');
                          }}
                          onEnter={(e) => handleMouseEnter(e, id)}
                          onLeave={handleMouseLeave}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {stats.total === 0 && (
              <div className="text-center text-gray-500 py-20 flex flex-col items-center">
                <Search className="w-8 h-8 mb-4 opacity-50" />
                <p>No tests match your filter criteria.</p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ── Action Bar (fixed) ────────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 w-full bg-card-bg/90 backdrop-blur-xl border-t border-border-subtle p-4 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.5)] animate-modal-pop">
          <div className="max-w-[1600px] mx-auto flex items-center justify-between px-4 md:px-8">
            <div className="flex items-center space-x-4">
              <div className="bg-brand-orange/20 border border-brand-orange/50 text-brand-orange w-10 h-10 rounded-full flex items-center justify-center font-bold font-mono shadow-[0_0_15px_rgba(213,96,28,0.3)]">
                {selected.size}
              </div>
              <div>
                <div className="text-xs font-bold text-white tracking-widest uppercase">
                  Tests Selected
                </div>
                <div className="text-[10px] text-gray-400">Ready for batch execution</div>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <button
                onClick={handleArchive}
                className="px-5 py-2.5 bg-transparent border border-brand-red/50 text-brand-red text-xs font-bold tracking-widest uppercase rounded-lg hover:bg-brand-red/10 transition-colors flex items-center gap-2"
              >
                <Archive className="w-4 h-4" />
                Archive
              </button>
              <button
                onClick={handleRunSelected}
                className="px-8 py-3 bg-gradient-to-r from-brand-orange to-brand-yellow text-black text-sm font-bold tracking-widest uppercase rounded-xl hover:scale-105 transition-transform flex items-center space-x-2 shadow-[0_0_20px_rgba(213,96,28,0.4)]"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{selected.size === 1 ? 'Run Test' : `Run Tests (${selected.size})`}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tooltip ───────────────────────────────────────────────────────────── */}
      {tooltip && tooltipTest && (
        <div
          className="fixed z-[100] w-80 bg-card-bg/95 backdrop-blur-xl border border-border-subtle rounded-xl p-5 shadow-2xl pointer-events-none"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, calc(-100% - 16px))',
          }}
        >
          <div className="flex justify-between items-start mb-4">
            <div>
              <span className="text-[9px] text-gray-500 uppercase tracking-widest mb-1 block">
                {tooltipTest.suiteName}
              </span>
              <span className="text-lg font-bold tracking-widest text-brand-orange font-mono leading-none">
                TEST #{tooltipTest.id.toString().padStart(3, '0')}
              </span>
            </div>
            <div className="text-right">
              <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest block mb-1">
                Execution Status
              </span>
              <div className="flex items-center justify-end space-x-2">
                <div
                  className={cn(
                    'w-2 h-2 rounded-full',
                    tooltipTest.status === 'Passed' &&
                      'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]',
                    tooltipTest.status === 'Failed' &&
                      'bg-brand-red shadow-[0_0_8px_rgba(239,68,68,0.6)]',
                    tooltipTest.status === 'Pending' &&
                      'bg-brand-yellow shadow-[0_0_8px_rgba(245,158,11,0.6)]',
                  )}
                />
                <span
                  className={cn(
                    'text-sm font-bold font-mono tracking-widest',
                    tooltipTest.status === 'Passed' && 'text-green-500',
                    tooltipTest.status === 'Failed' && 'text-brand-red',
                    tooltipTest.status === 'Pending' && 'text-brand-yellow',
                  )}
                >
                  {tooltipTest.status}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-app-bg p-3 rounded-xl border border-border-subtle">
              <div className="text-[8px] font-bold text-gray-500 uppercase tracking-widest mb-1">
                Total Tokens
              </div>
              <div className="flex items-baseline space-x-1">
                <span className="text-lg font-bold font-mono">
                  {tooltipTest.tokens.toLocaleString()}
                </span>
                <span className="text-[8px] text-gray-500 font-bold uppercase">Unit</span>
              </div>
            </div>
            <div className="bg-app-bg p-3 rounded-xl border border-border-subtle">
              <div className="text-[8px] font-bold text-gray-500 uppercase tracking-widest mb-1">
                Duration
              </div>
              <div className="flex items-baseline space-x-1">
                <span className="text-lg font-bold font-mono">{tooltipTest.duration}</span>
                <span className="text-[8px] text-gray-500 font-bold uppercase">Sec</span>
              </div>
            </div>
          </div>

          <p className="text-xs text-gray-300 leading-relaxed mb-4 line-clamp-2">
            {tooltipTest.description}
          </p>

          {tooltipTest.rootCause && (
            <div className="bg-brand-red/10 border border-brand-red/30 rounded px-3 py-2 mb-4">
              <span className="text-[9px] text-brand-red font-bold uppercase block mb-0.5">
                Auto-Detected Root Cause:
              </span>
              <span className="text-[10px] text-brand-red/80">{tooltipTest.rootCause}</span>
            </div>
          )}

          <div className="flex justify-between items-end border-t border-border-subtle pt-3">
            <div className="w-1/2">
              <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest block mb-1">
                History (Last 5)
              </span>
              <div className="flex items-end space-x-1 h-4">
                {tooltipTest.history.map((res, i) => (
                  <div
                    key={i}
                    className={cn(
                      'w-[3px] rounded-t-sm transition-all',
                      res === 'Passed' ? 'bg-green-500' : 'bg-brand-red',
                    )}
                    style={{ height: res === 'Passed' ? '100%' : '50%', opacity: (i + 1) * 0.2 }}
                  />
                ))}
              </div>
            </div>
            <span className="text-[10px] text-gray-500">{tooltipTest.timestamp}</span>
          </div>
        </div>
      )}

      {/* ── Modal ─────────────────────────────────────────────────────────────── */}
      {modalTest && (
        <div
          className="fixed inset-0 z-[150] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModalId(null);
          }}
        >
          <div className="bg-[#1b1422] border border-border-subtle rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col my-auto animate-modal-pop">
            {/* Header */}
            <div className="p-6 border-b border-border-subtle flex justify-between items-center bg-app-bg sticky top-0 z-10 rounded-t-2xl">
              <div>
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">
                  {modalTest.suiteName}
                </div>
                <h2 className="text-2xl font-bold text-white flex items-center space-x-3">
                  <span className="text-brand-orange font-mono">
                    #{modalTest.id.toString().padStart(3, '0')}
                  </span>
                  <span>Execution Trace</span>
                </h2>
              </div>
              <button
                onClick={() => setModalId(null)}
                className="text-gray-500 hover:text-white transition-colors p-2 rounded-lg hover:bg-white/5"
              >
                <XCircle className="w-6 h-6" />
              </button>
            </div>

            {/* Body */}
            <div className="p-8 flex-1">
              <div className="bg-app-bg rounded-xl border border-border-subtle p-5 mb-8">
                <h3 className="text-xs font-bold text-brand-pink uppercase tracking-widest mb-2">
                  Semantic Assertion
                </h3>
                <p className="text-gray-300 text-sm leading-relaxed">{modalTest.description}</p>
              </div>

              <div className="flex justify-between items-center mb-4 px-1">
                <span className="text-xs font-bold tracking-widest text-brand-accent uppercase">
                  Execution Steps
                </span>
                <span className="text-xs text-gray-500">Auto-Generated Trace</span>
              </div>

              <div className="space-y-4 mb-8">
                {modalTest.steps.map((step) => (
                  <div
                    key={step.num}
                    className={cn(
                      'bg-card-bg p-5 rounded-2xl border border-border-subtle',
                      step.type === 'LLM RESOLVED' && 'relative overflow-hidden',
                    )}
                  >
                    {step.type === 'LLM RESOLVED' && (
                      <div className="absolute top-0 left-0 w-full h-[2px] bg-brand-orange" />
                    )}
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <div className="text-[10px] font-bold text-gray-500 mb-1">
                          STEP {step.num}
                        </div>
                        <h3 className="text-base font-medium text-gray-200">{step.title}</h3>
                      </div>
                      <span
                        className={cn(
                          'text-[9px] font-bold border px-2 py-1 rounded uppercase tracking-wider relative',
                          step.type === 'LLM RESOLVED'
                            ? 'text-brand-orange border-brand-orange/30 bg-brand-orange/10'
                            : 'text-blue-400 border-blue-400/30 bg-blue-400/10',
                        )}
                      >
                        {step.type}
                        {step.type === 'LLM RESOLVED' && (
                          <>
                            <span className="absolute -top-1 -right-1 w-2 h-2 bg-brand-orange rounded-full animate-ping" />
                            <span className="absolute -top-1 -right-1 w-2 h-2 bg-brand-orange rounded-full" />
                          </>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center space-x-4 text-xs text-gray-400 mb-5">
                      <span className="flex items-center space-x-1">
                        <Clock className="w-3 h-3" />
                        <span>{step.time}</span>
                      </span>
                      <span className="flex items-center space-x-1">
                        <StepIcon icon={step.icon} />
                        <span>{step.tool}</span>
                      </span>
                    </div>
                    <div className="flex gap-3">
                      <button
                        className={cn(
                          'flex-1 py-2.5 rounded-lg font-bold text-xs flex items-center justify-center space-x-1.5 transition-colors',
                          step.pass
                            ? 'bg-gradient-to-r from-green-500/80 to-green-500 text-black'
                            : 'border border-border-subtle text-gray-500 hover:bg-white/5',
                        )}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>PASS</span>
                      </button>
                      <button
                        className={cn(
                          'flex-1 py-2.5 rounded-lg font-bold text-xs flex items-center justify-center space-x-1.5 transition-colors',
                          !step.pass
                            ? 'bg-gradient-to-r from-brand-red/80 to-brand-red text-white'
                            : 'border border-border-subtle text-gray-500 hover:bg-white/5',
                        )}
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>FAIL</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Force Pass Override */}
              {modalTest.status === 'Failed' && (
                <div className="bg-brand-orange/10 border border-brand-orange/30 rounded-xl p-5">
                  <h3 className="text-xs font-bold text-brand-orange uppercase tracking-widest mb-3 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    Status Override
                  </h3>
                  <div className="flex gap-4">
                    <input
                      type="text"
                      placeholder="Reason for forcing pass (Required)..."
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                      className="flex-1 bg-app-bg text-sm text-white rounded-lg px-4 py-3 border border-border-subtle outline-none focus:border-brand-orange/50 transition-colors"
                    />
                    <button
                      onClick={handleForcePass}
                      disabled={!overrideReason.trim()}
                      className="px-8 py-3 bg-green-500 text-black font-bold tracking-widest uppercase text-xs rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-[0_0_15px_rgba(34,197,94,0.3)]"
                    >
                      Force Pass
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Toast ─────────────────────────────────────────────────────────────── */}
      {toastMsg && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200] bg-card-bg/90 backdrop-blur-md border border-brand-orange/50 text-white px-6 py-3 rounded-full flex items-center space-x-3 shadow-[0_0_30px_rgba(213,96,28,0.2)] animate-toast-drop pointer-events-none">
          <AlertCircle className="w-4 h-4 text-brand-orange flex-shrink-0" />
          <span className="text-sm font-bold tracking-wider">{toastMsg}</span>
        </div>
      )}
    </>
  );
}
