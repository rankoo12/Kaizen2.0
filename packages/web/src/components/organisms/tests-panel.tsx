'use client';

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Plus, Play, Loader2, FlaskConical,
  Search, Settings, User, GitCompare, Archive, History, AlertCircle, LayoutDashboard
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useSuites } from '@/hooks/use-suites';
import { useCases } from '@/hooks/use-cases';
import { useRunPoller } from '@/hooks/use-run-poller';
import type { CaseSummary, Suite, RunStatus } from '@/types/api';

// ─── Run Watcher ─────────────────────────────────────────────────────────────
// Zero-render component. Owns one poller per active run and notifies parent on completion.

type RunWatcherProps = {
  caseId: string;
  runId: string;
  onComplete: (caseId: string, status: RunStatus) => void;
};

function RunWatcher({ caseId, runId, onComplete }: RunWatcherProps) {
  useRunPoller({
    runId,
    onComplete: (result) => onComplete(caseId, result.status),
  });
  return null;
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

type TooltipData = {
  tc: CaseSummary;
  x: number;
  y: number;
};

function TestTooltip({ data }: { data: TooltipData }) {
  const { tc, x, y } = data;
  const status = tc.lastRun?.status || 'pending';
  
  return (
    <div 
      className="fixed z-[100] w-80 bg-[#1b1422]/95 backdrop-blur-xl border border-white/10 rounded-xl p-5 shadow-2xl pointer-events-none transform -translate-x-1/2 -translate-y-[calc(100%+16px)] transition-all duration-200 ease-out animate-in fade-in zoom-in-95"
      style={{ left: x, top: y }}
    >
      <div className="flex justify-between items-start mb-4">
        <div className="flex-1 min-w-0 pr-4">
          <span className="text-[9px] text-gray-500 uppercase tracking-widest mb-1 block">
            ID: #{tc.id.slice(0, 8)}
          </span>
          <span className="text-lg font-bold tracking-widest text-brand-orange font-mono leading-none truncate block">
            {tc.name}
          </span>
        </div>
        <div className="text-right">
          <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest block mb-1">Execution Status</span>
          <div className="flex items-center justify-end space-x-2.5">
            <div className={cn(
              "w-2 h-2 rounded-full shadow-[0_0_10px]",
              status === 'passed' ? "bg-brand-green shadow-brand-green/60" :
              status === 'failed' ? "bg-brand-red shadow-brand-red/60" :
              "bg-brand-orange shadow-brand-orange/60"
            )} />
            <span className={cn(
              "text-sm font-bold font-mono tracking-widest uppercase",
              status === 'passed' ? "text-brand-green" :
              status === 'failed' ? "text-brand-red" :
              "text-brand-orange"
            )}>
              {status}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-[#110c14] p-3 rounded-xl border border-white/5">
          <div className="text-[8px] font-bold text-gray-500 uppercase tracking-widest mb-1">Total Tokens</div>
          <div className="flex items-baseline space-x-1">
            <span className="text-lg font-bold font-mono">{tc.lastRun?.totalTokens?.toLocaleString() || '0'}</span>
            <span className="text-[8px] text-gray-500 font-bold uppercase">Unit</span>
          </div>
        </div>
        <div className="bg-[#110c14] p-3 rounded-xl border border-white/5">
          <div className="text-[8px] font-bold text-gray-500 uppercase tracking-widest mb-1">Duration</div>
          <div className="flex items-baseline space-x-1">
            <span className="text-lg font-bold font-mono">
              {tc.lastRun?.durationMs ? (tc.lastRun.durationMs / 1000).toFixed(1) : '0.0'}
            </span>
            <span className="text-[8px] text-gray-500 font-bold uppercase">Sec</span>
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-300 leading-relaxed mb-4 line-clamp-2">
        {tc.name}. Targets {tc.baseUrl} for semantic validation.
      </p>
      
      <div className="flex justify-between items-end border-t border-white/10 pt-3">
        <div className="w-1/2">
          <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest block mb-1">History (Last 5)</span>
          <div className="flex items-end space-x-1 h-4">
             {/* Mock sparkline */}
             {[1,2,3,4,5].map(i => (
               <div key={i} className="w-[3px] rounded-t-sm bg-green-500/40 h-full"></div>
             ))}
          </div>
        </div>
        <span className="text-[10px] text-gray-500">
          {tc.lastRun?.completedAt ? new Date(tc.lastRun.completedAt).toLocaleTimeString() : 'Never run'}
        </span>
      </div>
    </div>
  );
}

// ─── Test Square ─────────────────────────────────────────────────────────────

type TestSquareProps = {
  tc: CaseSummary;
  selected: boolean;
  isRunning: boolean;
  comparisonMode: boolean;
  statusOverride?: RunStatus;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onHover: (data: TooltipData | null) => void;
};

function TestSquare({ tc, selected, isRunning, comparisonMode, statusOverride, onToggle, onOpen, onHover }: TestSquareProps) {
  const status = statusOverride ?? tc.lastRun?.status ?? 'pending';
  
  // Mock comparison logic: every 7th failed test is a "regression" for demo
  const isRegression = comparisonMode && status === 'failed' && parseInt(tc.id.slice(-1), 16) % 2 === 0;
  const isImprovement = comparisonMode && status === 'passed' && parseInt(tc.id.slice(-1), 16) % 3 === 0;

  return (
    <div
      onClick={() => onToggle(tc.id)}
      onDoubleClick={() => onOpen(tc.id)}
      onMouseEnter={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onHover({ tc, x: rect.left + rect.width / 2, y: rect.top });
      }}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "w-7 h-7 rounded flex items-center justify-center cursor-pointer transition-all duration-300 ease-out relative group",
        // Base Status Colors
        status === 'passed' ? "bg-brand-green/10 text-brand-green border-brand-green/20" :
        status === 'failed' ? "bg-brand-red/10 text-brand-red border-brand-red/20" :
        "bg-brand-yellow/10 text-brand-yellow border-brand-yellow/20",
        // Comparison Highlights
        isRegression && "bg-brand-red/20 text-brand-red border-brand-red border-2 animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.5)] z-10 opacity-100",
        isImprovement && "bg-brand-green/20 text-brand-green border-brand-green/50 border-2 shadow-[0_0_15px_rgba(34,197,94,0.3)] z-10 opacity-100",
        // Selection State
        selected && "!border-2 !border-brand-orange !shadow-[0_0_15px_rgba(213,96,28,0.8)] scale-110 z-20 !opacity-100",
        // Running state
        isRunning && "!border-2 !border-brand-orange/50 shadow-[0_0_10px_rgba(213,96,28,0.3)] opacity-75",
        // Hover
        "hover:scale-110 hover:z-30 hover:border-white/50 hover:opacity-100",
        // Fade out non-interest in comparison mode
        comparisonMode && !isRegression && !isImprovement && "opacity-20 translate-z-0"
      )}
    >
      {isRunning ? (
        <Loader2 className="w-3 h-3 animate-spin text-brand-orange" />
      ) : (
        <span className="text-[9px] font-mono font-bold pointer-events-none select-none">
          {tc.id.slice(-2)}
        </span>
      )}
    </div>
  );
}

// ─── Suite Group ─────────────────────────────────────────────────────────────

type SuiteGroupProps = {
  suite: Suite;
  searchQuery: string;
  selectedIds: Set<string>;
  runningMap: Map<string, string>;
  comparisonMode: boolean;
  statusOverrides: Map<string, RunStatus>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onHover: (data: TooltipData | null) => void;
  onSelectAll: (ids: string[]) => void;
};

function SuiteGroup({ suite, searchQuery, selectedIds, runningMap, comparisonMode, statusOverrides, onToggle, onOpen, onHover, onSelectAll }: SuiteGroupProps) {
  const { cases, isLoading } = useCases(suite.id);

  const filteredCases = useMemo(() => {
    if (!searchQuery) return cases;
    const q = searchQuery.toLowerCase();
    return cases.filter(c => c.name.toLowerCase().includes(q) || c.id.includes(q));
  }, [cases, searchQuery]);

  if (!isLoading && filteredCases.length === 0 && searchQuery) return null;

  return (
    <div className="flex flex-col space-y-4">
      <div className="text-[10px] font-bold text-gray-500 tracking-[0.2em] uppercase flex justify-between items-center sticky top-0 bg-[#1b1422] py-3 z-10 border-b border-white/10 px-1">
        <span>{suite.name}</span>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => onSelectAll(filteredCases.map(c => c.id))}
            className="text-[10px] text-brand-pink border border-brand-pink/30 bg-brand-pink/10 hover:bg-brand-pink/20 px-3 py-1 rounded uppercase tracking-wider transition-colors"
          >
            Select Suite
          </button>
          <span className="text-[9px] text-gray-600 bg-[#22192b] px-3 py-1 rounded shadow-inner border border-white/5">
            {isLoading ? '...' : filteredCases.length} TESTS
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 min-h-[40px]">
        {isLoading ? (
          <div className="w-full flex justify-center py-4">
            <Loader2 className="w-4 h-4 animate-spin text-gray-600" />
          </div>
        ) : filteredCases.map(tc => (
          <TestSquare
            key={tc.id}
            tc={tc}
            selected={selectedIds.has(tc.id)}
            isRunning={runningMap.has(tc.id)}
            comparisonMode={comparisonMode}
            statusOverride={statusOverrides.get(tc.id)}
            onToggle={onToggle}
            onOpen={onOpen}
            onHover={onHover}
          />
        ))}
      </div>
    </div>
  );
}

// ─── TestsPanel ───────────────────────────────────────────────────────────────

export function TestsPanel() {
  const router = useRouter();
  const { suites, isLoading: suitesLoading } = useSuites();

  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [quickId, setQuickId] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [runningMap, setRunningMap] = useState<Map<string, string>>(new Map()); // caseId -> runId
  const [statusOverrides, setStatusOverrides] = useState<Map<string, RunStatus>>(new Map()); // caseId -> completed status
  const [comparisonMode, setComparisonMode] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Handlers
  const toggleCase = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectSuite = useCallback((ids: string[]) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.add(id));
      return next;
    });
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const handleRunComplete = useCallback((caseId: string, status: RunStatus) => {
    setRunningMap(prev => {
      const next = new Map(prev);
      next.delete(caseId);
      return next;
    });
    setStatusOverrides(prev => new Map(prev).set(caseId, status));
    showToast(`Run ${status.toUpperCase()}.`);
  }, [showToast]);

  const runTest = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/proxy/cases/${id}/run`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (!res.ok) throw new Error();
      const { runId } = await res.json();
      setRunningMap(prev => new Map(prev).set(id, runId));
    } catch {
      showToast('Failed to enqueue test run.');
    }
  }, []);

  const runSelected = async () => {
    const ids = Array.from(selectedIds);
    showToast(`Executing ${ids.length} tests concurrently...`);
    for (const id of ids) {
      runTest(id);
    }
    setSelectedIds(new Set());
  };

  const handleSmartSelect = (type: 'failed' | 'regressions') => {
    // This requires iterating over all cases in all suites which we don't have easily in flat form here.
    // For now, let's keep it simple or implement a way to gather them.
    showToast(`Smart selection for ${type} not fully implemented yet.`);
  };

  const quickSelect = (e: React.FormEvent) => {
    e.preventDefault();
    if (quickId) {
      // Logic to find case with this ID suffix or prefix
      showToast(`Quick select for #${quickId}`);
      setQuickId('');
    }
  };

  return (
    <div className="bg-[#110c14] text-white font-sans min-h-screen flex flex-col selection:bg-brand-orange/30 pb-24 relative overflow-hidden">
      
      {/* TOP NAVIGATION */}
      <nav className="flex items-center justify-between px-8 py-4 border-b border-white/10 bg-[#110c14]/80 backdrop-blur-md sticky top-0 z-40">
        <div className="flex items-center space-x-8">
          <div className="text-2xl font-bold tracking-wider cursor-pointer font-mono flex items-center">
            <span>KAI</span><span className="text-brand-orange">ZEN</span>
          </div>
          <div className="h-6 w-px bg-white/10"></div>
          <span className="text-xs font-bold tracking-[0.15em] text-gray-500 uppercase">Analysis Engine</span>
        </div>

        {/* Search & Quick Action */}
        <div className="flex items-center space-x-4 flex-1 max-w-2xl px-8">
          <div className="relative flex-1 group">
             <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 transition-colors group-focus-within:text-brand-orange" />
             <input 
               type="text" 
               placeholder="Filter by description, root cause, suite..." 
               className="w-full bg-[#1b1422] border border-white/10 rounded-full py-2 pl-10 pr-4 text-sm text-white outline-none focus:border-brand-orange/50 transition-all font-medium"
               value={searchQuery}
               onChange={(e) => setSearchQuery(e.target.value)}
             />
          </div>
          <form onSubmit={quickSelect} className="relative">
            <input 
              type="text" 
              placeholder="ID (e.g. #42)" 
              className="w-28 bg-[#1b1422] border border-white/10 rounded-full py-2 px-4 text-sm text-center text-white outline-none focus:border-brand-orange/50 font-mono transition-all"
              value={quickId}
              onChange={(e) => setQuickId(e.target.value)}
            />
          </form>
        </div>

        <div className="flex items-center space-x-6">
          <button className="text-gray-400 hover:text-white transition-colors"><Settings className="w-5 h-5" /></button>
          <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-brand-pink to-brand-orange p-[1px] cursor-pointer hover:scale-105 transition-transform">
            <div className="w-full h-full bg-[#1b1422] rounded-full flex items-center justify-center overflow-hidden">
              <User className="w-4 h-4 text-white/80" />
            </div>
          </div>
        </div>
      </nav>

      {/* MAIN CONTENT */}
      <main className="p-4 md:p-8 max-w-[1600px] mx-auto w-full flex flex-col gap-6 relative">
        
        {/* Header Controls */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#1b1422] p-6 rounded-2xl border border-white/10 shadow-lg">
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-2">Execution & Analysis</h1>
            <p className="text-brand-pink/80 text-sm">Monitoring semantic validations across all suites</p>
          </div>
          
          <div className="flex flex-col md:flex-row items-center gap-4">
            {/* Smart Selectors */}
            <div className="flex items-center space-x-2 bg-[#0a070c] p-1 rounded-lg border border-white/10">
              <button 
                onClick={() => handleSmartSelect('failed')}
                className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-red hover:bg-white/5 rounded transition-colors"
              >
                All Failed
              </button>
              <div className="w-px h-4 bg-white/10"></div>
              <button 
                onClick={() => handleSmartSelect('regressions')}
                className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-brand-orange hover:bg-white/5 rounded transition-colors"
              >
                Regressions
              </button>
              <div className="w-px h-4 bg-white/10"></div>
              <button 
                onClick={() => setSelectedIds(new Set())}
                className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-gray-400 hover:bg-white/5 rounded transition-colors"
              >
                Clear
              </button>
            </div>

            {/* Comparison Toggle */}
            <button 
              onClick={() => setComparisonMode(!comparisonMode)}
              className={cn(
                "px-3 py-2 rounded-lg text-xs font-bold tracking-widest uppercase flex items-center space-x-2 transition-all border",
                comparisonMode 
                  ? "bg-brand-orange/10 text-brand-orange border-brand-orange/50 shadow-[0_0_15px_rgba(213,96,28,0.2)]" 
                  : "bg-[#0a070c] text-gray-400 border-white/10 hover:border-white/30 hover:text-white"
              )}
            >
              <GitCompare className="w-3.5 h-3.5" />
              <span>Compare</span>
            </button>

            {/* Add New Test Action */}
            <button 
              onClick={() => router.push('/tests/new')}
              className="px-5 py-2.5 bg-brand-orange text-black text-sm font-bold tracking-widest uppercase rounded-xl hover:scale-105 transition-transform flex items-center space-x-2 shadow-[0_0_15px_rgba(249,115,22,0.4)]"
            >
              <Plus className="w-4 h-4" />
              <span>Add New Test</span>
            </button>
          </div>
        </div>

        {/* COMPARISON LEGEND */}
        {comparisonMode && (
          <div className="bg-[#1b1422]/80 border border-brand-orange/30 p-4 rounded-xl flex items-center justify-between shadow-lg">
            <div className="flex items-center space-x-3">
              <History className="w-5 h-5 text-brand-orange" />
              <span className="text-sm font-bold text-white tracking-widest uppercase">BASELINE: Last Successful Run</span>
            </div>
            <div className="flex items-center space-x-6 text-xs font-bold tracking-widest uppercase">
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 border-2 border-brand-red shadow-[0_0_10px_rgba(239,68,68,0.5)]"></div>
                <span className="text-brand-red"><span id="regressionsCount">–</span> Regressions</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 bg-green-500/20 border-2 border-green-500/50 shadow-[0_0_10px_rgba(34,197,94,0.3)]"></div>
                <span className="text-green-500"><span id="improvementsCount">–</span> Improvements</span>
              </div>
            </div>
          </div>
        )}

        {/* GRID CONTAINER */}
        <div className="bg-[#1b1422] p-5 rounded-2xl border border-white/10 shadow-lg min-h-[500px]">
          <div className="flex flex-col gap-8 max-h-[60vh] overflow-y-auto pr-2">
            {suitesLoading ? (
              <div className="flex flex-col items-center justify-center py-20 gap-4 text-gray-500">
                <Loader2 className="w-8 h-8 animate-spin" />
                <p className="text-sm font-bold tracking-widest uppercase">Initializing Suites...</p>
              </div>
            ) : suites.length === 0 ? (
              <div className="text-center py-20 flex flex-col items-center text-gray-500">
                <FlaskConical className="w-12 h-12 mb-4 opacity-50" />
                <p>No suites found. Start by creating a new test.</p>
              </div>
            ) : suites.map(suite => (
              <SuiteGroup
                key={suite.id}
                suite={suite}
                searchQuery={searchQuery}
                selectedIds={selectedIds}
                runningMap={runningMap}
                comparisonMode={comparisonMode}
                statusOverrides={statusOverrides}
                onToggle={toggleCase}
                onOpen={(id) => router.push(`/tests/${id}`)}
                onHover={setTooltip}
                onSelectAll={selectSuite}
              />
            ))}
          </div>
        </div>
      </main>

      {/* ACTION BAR */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-0 left-0 w-full bg-[#1b1422]/90 backdrop-blur-xl border-t border-white/10 p-4 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
          <div className="max-w-[1600px] mx-auto flex items-center justify-between px-8">
            <div className="flex items-center space-x-4">
              <div className="bg-brand-orange/20 border border-brand-orange/50 text-brand-orange w-10 h-10 rounded-full flex items-center justify-center font-bold font-mono shadow-[0_0_15px_rgba(213,96,28,0.3)]">
                {selectedIds.size}
              </div>
              <div>
                <div className="text-xs font-bold text-white tracking-widest uppercase">Tests Selected</div>
                <div className="text-[10px] text-gray-400">Ready for batch execution</div>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <button className="px-4 py-2.5 bg-transparent border border-brand-red/50 text-brand-red text-xs font-bold tracking-widest uppercase rounded-lg hover:bg-brand-red/10 transition-colors flex items-center gap-2">
                <Archive className="w-4 h-4" /> Archive
              </button>
              <button
                onClick={() => {
                  const ids = Array.from(selectedIds);
                  router.push(`/tests/${ids[0]}`);
                }}
                className="px-5 py-2.5 bg-brand-pink/10 border border-brand-pink/30 text-brand-pink text-xs font-bold tracking-widest uppercase rounded-lg hover:bg-brand-pink/20 transition-colors flex items-center gap-2"
              >
                <LayoutDashboard className="w-4 h-4" /> View Tests
              </button>
              <button
                onClick={runSelected}
                className="px-8 py-3 bg-gradient-to-r from-brand-orange to-brand-yellow text-black text-sm font-bold tracking-widest uppercase rounded-xl hover:scale-105 transition-transform flex items-center space-x-2 shadow-[0_0_20px_rgba(213,96,28,0.4)]"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Run {selectedIds.size === 1 ? 'Test' : `Tests (${selectedIds.size})`}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RUN WATCHERS — one per active run, each owns a poller */}
      {Array.from(runningMap.entries()).map(([caseId, runId]) => (
        <RunWatcher key={runId} caseId={caseId} runId={runId} onComplete={handleRunComplete} />
      ))}

      {/* TOOLTIP */}
      {tooltip && <TestTooltip data={tooltip} />}

      {/* TOAST */}
      {toast && (
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[200] bg-[#1b1422]/90 backdrop-blur-md border border-brand-orange/50 text-white px-6 py-3 rounded-full flex items-center space-x-3 shadow-[0_0_30px_rgba(213,96,28,0.2)] animate-in slide-in-from-top-4">
          <AlertCircle className="w-4 h-4 text-brand-orange" />
          <span className="text-sm font-bold tracking-wider">{toast}</span>
        </div>
      )}
    </div>
  );
}
