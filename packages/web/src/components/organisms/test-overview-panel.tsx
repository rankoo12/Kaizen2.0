import { useState, useMemo } from 'react';
import { 
  Settings, User, CheckCircle2, Loader2, Clock, 
  Eye, Zap, Database, Code, Cpu, Play, Search, ArrowLeft, XCircle, Image as ImageIcon, X
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useCaseDetail } from '@/hooks/use-case-detail';
import { useRunDetail } from '@/hooks/use-run-detail';
import type { StepResult } from '@/types/api';

type TestOverviewPanelProps = {
  caseId: string;
};

export function TestOverviewPanel({ caseId }: TestOverviewPanelProps) {
  const router = useRouter();
  const { data: test, isLoading: caseLoading, error: caseError } = useCaseDetail(caseId);
  
  const lastRunId = test?.recentRuns?.[0]?.id;
  const { data: runDetail, isLoading: runLoading } = useRunDetail(lastRunId);

  const [viewMode, setViewMode] = useState<'preview' | 'results'>('results');
  const [activeScreenshot, setActiveScreenshot] = useState<string | null>(null);

  if (caseLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-40 gap-4 text-gray-500">
        <Loader2 className="w-8 h-8 animate-spin" />
        <p className="text-xs font-bold tracking-widest uppercase">Fetching Neural Trace...</p>
      </div>
    );
  }

  if (caseError || !test) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-40 gap-4 text-brand-red">
        <XCircle className="w-12 h-12" />
        <p className="text-sm font-bold tracking-widest uppercase">Test data not found</p>
        <button onClick={() => router.push('/tests')} className="text-xs underline text-gray-400">Back to dashboard</button>
      </div>
    );
  }

  const runStatus = runDetail?.status || test.recentRuns?.[0]?.status || 'pending';

  return (
    <div className="flex-1 p-6 md:p-8 max-w-[1600px] mx-auto w-full grid grid-cols-1 xl:grid-cols-12 gap-8 relative">
      
      {/* LIGHTBOX OVERLAY */}
      {activeScreenshot && (
        <div 
          className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-xl flex items-center justify-center p-4 md:p-20 animate-in fade-in duration-300"
          onClick={() => setActiveScreenshot(null)}
        >
          <button 
            className="absolute top-8 right-8 p-3 rounded-full bg-white/10 text-white hover:bg-white/20 transition-all z-[210]"
            onClick={() => setActiveScreenshot(null)}
          >
            <X className="w-8 h-8" />
          </button>
          <img 
            src={`/api/proxy/media?key=${activeScreenshot}`} 
            alt="Full Screen Trace" 
            className="max-w-full max-h-full object-contain shadow-[0_0_100px_rgba(213,96,28,0.3)] rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* LEFT COLUMN: Main Process */}
      <div className="xl:col-span-8 space-y-8 animate-in fade-in slide-in-from-left-4 duration-500">
        
        {/* Header Text */}
        <div className="space-y-3">
          <div className="flex items-center gap-4">
             <button 
               onClick={() => router.push('/tests')}
               className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
             >
               <ArrowLeft className="w-4 h-4" />
             </button>
             <h1 className="text-4xl md:text-5xl font-bold tracking-tight">{test.name}</h1>
          </div>
          <p className="text-brand-pink/80 text-sm md:text-base ml-12">
            Visually validate and execute semantic test suites targeting the Kaizen Engine
          </p>
        </div>

        {/* Process Table Panel */}
        <div className="bg-panel-bg rounded-2xl border border-white/10 overflow-hidden shadow-2xl">
          
          {/* Table Header */}
          <div className="grid grid-cols-12 gap-4 p-6 border-b border-white/10 text-xs font-bold tracking-wider text-brand-accent uppercase">
            <div className="col-span-2">Step ID</div>
            <div className="col-span-7">Description</div>
            <div className="col-span-3 text-right">Status</div>
          </div>

          {/* Table Body */}
          <div className="flex flex-col">
            {test.steps.map((step, idx) => {
              const result = runDetail?.stepResults?.find(sr => sr.stepId === step.id);
              const status = result?.status || (idx === 0 && runStatus === 'running' ? 'running' : 'pending');

              return (
                <div key={step.id} className={cn(
                  "grid grid-cols-12 gap-4 p-6 border-b border-white/10 items-center hover:bg-white/[0.02] transition-colors",
                  status === 'pending' && "opacity-60"
                )}>
                  <div className="col-span-2 font-mono text-sm text-brand-pink">
                    {String(step.position + 1).padStart(3, '0')}
                  </div>
                  <div className="col-span-7 text-sm text-gray-200">
                    {step.rawText}
                  </div>
                  <div className={cn(
                    "col-span-3 flex items-center justify-end space-x-2",
                    status === 'passed' ? "text-brand-green" : status === 'running' ? "text-brand-orange" : "text-gray-500"
                  )}>
                    {status === 'passed' && <CheckCircle2 className="w-4 h-4" />}
                    {status === 'running' && <Loader2 className="w-4 h-4 animate-spin" />}
                    {status === 'pending' && <Clock className="w-4 h-4" />}
                    <span className="text-xs font-bold tracking-wide uppercase">
                      {status === 'passed' ? 'VERIFIED' : status === 'running' ? 'PROCESSING' : 'PENDING'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Bottom Action Buttons */}
        <div className="bg-panel-bg p-6 rounded-2xl border border-white/10 flex flex-col md:flex-row gap-4 shadow-lg">
          <button className="flex-1 py-4 border-2 border-dashed border-brand-accent/40 text-brand-accent text-xs font-bold tracking-widest uppercase rounded-xl hover:bg-brand-accent/5 transition-colors">
            + Add Neural Step
          </button>
          <button className="flex-1 py-4 bg-gradient-to-r from-brand-orange to-brand-yellow text-black text-sm font-bold tracking-widest uppercase rounded-xl hover:opacity-90 transition-opacity flex items-center justify-center space-x-2 shadow-lg hover:shadow-brand-orange/20">
            <Play className="w-4 h-4 fill-current" />
            <span>Run</span>
          </button>
        </div>
      </div>

      {/* RIGHT COLUMN: Results & Status */}
      <div className="xl:col-span-4 space-y-6 animate-in fade-in slide-in-from-right-4 duration-500">
        
        {/* Top Toggle */}
        <div className="flex items-center justify-between text-xs font-bold tracking-wider border-b border-white/10 pb-2">
          <button 
            onClick={() => setViewMode('preview')}
            className={cn(
              "flex items-center space-x-2 transition-colors px-4 py-2",
              viewMode === 'preview' ? "text-brand-pink underline underline-offset-8" : "text-gray-400 hover:text-white"
            )}
          >
            <Eye className="w-4 h-4" />
            <span>LIVE DOM PREVIEW</span>
          </button>
          <button 
            onClick={() => setViewMode('results')}
            className={cn(
              "px-6 py-2 rounded-lg transition-all",
              viewMode === 'results' ? "bg-gradient-to-r from-brand-orange to-brand-yellow text-black" : "text-gray-400"
            )}
          >
            SUMMARY RESULTS
          </button>
        </div>

        {/* Test Results Header */}
        <div className="flex items-center space-x-2 bg-panel-bg rounded-lg p-4 border border-white/10 shadow-md">
          <div className="w-2 h-2 rounded-full bg-brand-accent" />
          <span className="text-sm font-bold tracking-widest text-brand-accent uppercase">Test Results</span>
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-panel-bg p-5 rounded-2xl border border-white/10 shadow-inner">
            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Total Tokens</div>
            <div className="flex items-baseline space-x-1">
              <span className="text-3xl font-bold font-mono text-white">
                {runDetail?.totalTokens?.toLocaleString() || test.recentRuns?.[0]?.totalTokens?.toLocaleString() || '0'}
              </span>
              <span className="text-[10px] text-gray-500 font-bold uppercase">Unit</span>
            </div>
          </div>
          <div className="bg-panel-bg p-5 rounded-2xl border border-white/10 shadow-inner">
            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Duration</div>
            <div className="flex items-baseline space-x-1">
              <span className="text-3xl font-bold font-mono text-white">
                {(runDetail?.durationMs || test.recentRuns?.[0]?.durationMs) ? ((runDetail?.durationMs || test.recentRuns?.[0]?.durationMs || 0) / 1000).toFixed(1) : '0.0'}
              </span>
              <span className="text-[10px] text-gray-500 font-bold uppercase">Sec</span>
            </div>
          </div>
        </div>

        {/* Execution Status Banner */}
        <div className="bg-panel-bg p-6 rounded-2xl border border-white/10 shadow-inner shadow-black/50">
          <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Execution Status</div>
          <div className="flex items-center space-x-3">
            <div className={cn(
              "w-2.5 h-2.5 rounded-full",
              runStatus === 'passed' ? "bg-brand-green shadow-[0_0_10px_rgba(34,197,94,0.5)]" :
              runStatus === 'failed' ? "bg-brand-red shadow-[0_0_10px_rgba(239,68,68,0.5)]" :
              "bg-brand-yellow shadow-[0_0_10px_rgba(245,158,11,0.5)]"
            )} />
            <span className="text-3xl font-bold tracking-widest font-mono text-white uppercase">
              {runStatus}
            </span>
          </div>
        </div>

        {/* Detailed Execution Log */}
        <div className="space-y-4 overflow-y-auto max-h-[500px] pr-2 custom-scrollbar">
          <div className="flex justify-between items-center mb-4 px-1">
            <span className="text-xs font-bold tracking-widest text-gray-400 uppercase">Execution</span>
            <span className="text-xs text-gray-500">History Trace</span>
          </div>

          <div className="space-y-4 pb-12">
            {!runDetail && runLoading && (
               <div className="flex items-center justify-center py-10 text-gray-500">
                 <Loader2 className="w-5 h-5 animate-spin mr-2" />
                 <span className="text-xs font-bold uppercase tracking-widest">Loading run details...</span>
               </div>
            )}
            
            {runDetail?.stepResults?.map((stepResult, idx) => (
              <ExecutionCard 
                key={stepResult.id}
                id={String(idx + 1).padStart(3, '0')} 
                title={test.steps.find(s => s.id === stepResult.stepId)?.rawText || "Neural Action"} 
                type={stepResult.resolutionSource || "LLM RESOLVED"} 
                time={`${stepResult.durationMs || 0}ms`} 
                tool={stepResult.errorType || "GPT-4_Agent"} 
                status={stepResult.status} 
                screenshotKey={stepResult.screenshotKey}
                onViewScreenshot={setActiveScreenshot}
                icon={<Cpu className="w-3 h-3" />} 
              />
            ))}

            {!runDetail && !runLoading && (
              <div className="text-center py-10 text-gray-600 text-[10px] font-bold uppercase tracking-widest border border-white/5 rounded-xl border-dashed">
                No execution history for this view.
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

function ExecutionCard({ id, title, type, time, tool, status, icon, isActive, screenshotKey, onViewScreenshot }: any) {
  return (
    <div className={cn(
      "bg-panel-bg p-5 rounded-2xl border border-white/10 relative overflow-hidden transition-all",
      isActive && "ring-1 ring-brand-orange shadow-[0_0_20px_rgba(213,96,28,0.1)]"
    )}>
      {isActive && <div className="absolute top-0 left-0 w-full h-[2px] bg-brand-orange" />}
      
      <div className="flex justify-between items-start mb-3">
        <div className="flex-1 min-w-0 pr-2">
          <div className="text-[10px] font-bold text-gray-500 mb-1 uppercase tracking-tighter">STEP {id}</div>
          <h3 className="text-sm font-medium text-gray-200 truncate">{title}</h3>
        </div>
        <span className={cn(
          "text-[9px] font-bold border px-2 py-1 rounded uppercase tracking-wider relative whitespace-nowrap",
          type?.includes('LLM') ? "text-brand-orange border-brand-orange/30 bg-brand-orange/10" : "text-blue-400 border-blue-400/30 bg-blue-400/10"
        )}>
          {type}
          {isActive && (
            <>
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-brand-orange rounded-full animate-ping" />
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-brand-orange rounded-full" />
            </>
          )}
        </span>
      </div>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center space-x-4 text-xs text-gray-400">
          <span className="flex items-center space-x-1"><Clock className="w-3 h-3" /> <span>{time}</span></span>
          <span className="flex items-center space-x-1">{icon} <span>{tool}</span></span>
        </div>
        {screenshotKey && (
          <button 
            onClick={() => onViewScreenshot(screenshotKey)}
            className="flex items-center space-x-1.5 text-[10px] font-bold text-brand-pink hover:text-white transition-colors bg-brand-pink/10 px-2 py-1 rounded border border-brand-pink/20"
          >
            <ImageIcon className="w-3 h-3" />
            <span>IMAGE</span>
          </button>
        )}
      </div>
      <div className="flex gap-3">
        <button className={cn(
          "flex-1 py-2.5 rounded-lg font-bold text-xs flex items-center justify-center space-x-1.5 transition-all",
          status === 'passed' ? "bg-gradient-to-r from-brand-green/80 to-brand-green text-black" : "border border-white/5 text-gray-600 grayscale hover:grayscale-0 hover:bg-white/5"
        )}>
          <CheckCircle2 className="w-3.5 h-3.5" /> <span>PASS</span>
        </button>
        <button className={cn(
          "flex-1 py-2.5 rounded-lg font-bold text-xs flex items-center justify-center space-x-1.5 transition-all",
          status === 'failed' ? "bg-gradient-to-r from-brand-red/80 to-brand-red text-white" : "border border-white/5 text-gray-600 grayscale hover:grayscale-0 hover:bg-white/5"
        )}>
          <XCircle className="w-3.5 h-3.5" /> <span>FAIL</span>
        </button>
      </div>
    </div>
  );
}

