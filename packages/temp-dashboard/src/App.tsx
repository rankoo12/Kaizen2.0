import { useState, useEffect } from 'react';
import './index.css';

// Using the dev tenant by default since API lacks auth currently
const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';

interface HealingEvent {
  id: string;
  failure_class: string;
  strategy_used: string;
  attempts: number;
  succeeded: boolean;
  duration_ms: number;
}

type ResolutionSource = 'redis' | 'db_exact' | 'pgvector_step' | 'pgvector_element' | 'llm' | null;

const RESOLUTION_LABELS: Record<NonNullable<ResolutionSource>, string> = {
  redis:            'L1 Redis',
  db_exact:         'L2 DB Exact',
  pgvector_step:    'L3 Vector (step)',
  pgvector_element: 'L2.5 Vector (element)',
  llm:              'L5 LLM',
};

interface CompactCandidate {
  kaizenId: string;
  role: string;
  name: string;
  selector: string;
}

interface StepResult {
  id: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  cache_hit: boolean;
  duration_ms?: number;
  error_type?: string;
  failure_class?: string;
  screenshot_key?: string;
  selector_used?: string;
  healingEvents: HealingEvent[];
  tokens?: number;
  user_verdict?: 'passed' | 'failed' | null;
  resolution_source?: ResolutionSource;
  similarity_score?: number | null;
  dom_candidates?: CompactCandidate[] | null;
  llm_picked_kaizen_id?: string | null;
}

interface RunData {
  id: string;
  status: RunStatus;
  started_at: string | null;
  completed_at: string | null;
  environment_url: string;
  stepResults?: StepResult[];
  total_tokens?: number;
}

function StepCard({ step, idx, stepText, apiEndpoint, runId, onImageClick, onVerdictChange }: {
  step: StepResult;
  idx: number;
  stepText: string;
  apiEndpoint: string;
  runId: string;
  onImageClick: (url: string) => void;
  onVerdictChange: (stepId: string, verdict: 'passed' | 'failed') => void;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  const [verdictLoading, setVerdictLoading] = useState(false);

  const handleVerdict = async (verdict: 'passed' | 'failed') => {
    if (verdictLoading || step.user_verdict === verdict) return;
    setVerdictLoading(true);
    try {
      const res = await fetch(`${apiEndpoint}/runs/${runId}/steps/${step.id}/verdict`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict }),
      });
      if (res.ok) onVerdictChange(step.id, verdict);
    } finally {
      setVerdictLoading(false);
    }
  };

  const isPinned = step.user_verdict === 'passed';

  return (
    <div className={`step-card ${step.status}${isPinned ? ' pinned' : ''}`}>
      <div className="step-header">
        <span className="step-text">
          {idx + 1}. {stepText || 'Unknown Step'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {isPinned && (
            <span className="verdict-locked-badge">🔒 Pinned</span>
          )}
          <span className={`status-badge ${step.status}`} style={{ fontSize: '0.7em', padding: '0.1rem 0.5rem' }}>
            {step.status}
          </span>
        </div>
      </div>

      {(step.duration_ms || step.cache_hit || step.tokens !== undefined) && (
        <div className="step-meta">
          {step.duration_ms !== undefined && (
            <span className="meta-item">⏱ {step.duration_ms}ms</span>
          )}
          {step.tokens !== undefined && step.tokens > 0 && (
            <span className="meta-item">🪙 {step.tokens} tokens</span>
          )}
          {step.resolution_source && (
            <span className={`meta-item resolution-source ${step.resolution_source}`}>
              {step.resolution_source === 'llm' ? '🤖' : '⚡'} {RESOLUTION_LABELS[step.resolution_source]}
              {step.similarity_score != null && ` · ${(step.similarity_score * 100).toFixed(1)}%`}
            </span>
          )}
        </div>
      )}

      {step.healingEvents && step.healingEvents.length > 0 && (
        <div className="step-meta" style={{ marginTop: '0.5rem', flexWrap: 'wrap' }}>
          {step.healingEvents.map(h => (
            <span key={h.id} className="meta-item heal">
              🩹 Healed via {h.strategy_used} ({h.duration_ms}ms)
            </span>
          ))}
        </div>
      )}

      {step.status === 'failed' && step.failure_class && (
        <div className="error-box">
          <strong>{step.failure_class}:</strong> {step.error_type}
        </div>
      )}

      {step.screenshot_key && (
        <div style={{ marginTop: '1rem' }}>
          <img 
            src={`${apiEndpoint}/media?key=${encodeURIComponent(step.screenshot_key)}`} 
            alt={`Screenshot for step ${idx + 1}`} 
            className="step-screenshot" 
            onClick={() => onImageClick(`${apiEndpoint}/media?key=${encodeURIComponent(step.screenshot_key!)}`)}
          />
        </div>
      )}

      <div className="verdict-row">
        <button
          className={`btn-verdict pass${step.user_verdict === 'passed' ? ' active' : ''}`}
          onClick={() => handleVerdict('passed')}
          disabled={verdictLoading || step.user_verdict === 'passed'}
          title={isPinned ? 'Selector is pinned — will not be changed by healing' : 'Mark as passed and pin this selector'}
        >
          ✓ Pass{isPinned ? ' (Pinned)' : ''}
        </button>
        <button
          className={`btn-verdict fail${step.user_verdict === 'failed' ? ' active' : ''}`}
          onClick={() => handleVerdict('failed')}
          disabled={verdictLoading || step.user_verdict === 'failed'}
          title="Mark as failed"
        >
          ✕ Fail
        </button>
      </div>

      <div style={{ marginTop: '0.5rem' }}>
        <button className="btn-trace-toggle" onClick={() => setTraceOpen(!traceOpen)}>
          {traceOpen ? '▼ Hide Execution Trace' : '▶ View Execution Trace'}
        </button>
        {traceOpen && (
          <div className="trace-terminal">
            <div className="trace-line">
              <span className="trace-label">Resolution Origin:</span>
              <span className="trace-value">
                {step.resolution_source ? RESOLUTION_LABELS[step.resolution_source] : 'Unknown'}
                {step.similarity_score != null && (
                  <span style={{ marginLeft: '0.5rem', color: 'var(--success)' }}>
                    (cosine {(step.similarity_score * 100).toFixed(2)}%)
                  </span>
                )}
              </span>
            </div>
            {step.selector_used && (
              <div className="trace-line">
                <span className="trace-label">Resolved Target:</span>
                <span className="trace-value highlight">{step.selector_used}</span>
              </div>
            )}
            <div className="trace-line">
              <span className="trace-label">Latency:</span>
              <span className="trace-value">{step.duration_ms ?? 0}ms</span>
            </div>
            {step.tokens !== undefined && step.tokens > 0 && (
              <div className="trace-line">
                <span className="trace-label">Token Cost:</span>
                <span className="trace-value warning">{step.tokens} tokens</span>
              </div>
            )}
            {step.healingEvents && step.healingEvents.length > 0 && (
              <div className="trace-line">
                <span className="trace-label">Healing Interventions:</span>
                {step.healingEvents.map(h => (
                  <span key={h.id} className="trace-value warning" style={{ marginLeft: '1rem', display: 'block' }}>
                    - [{h.failure_class}] Triggered {h.strategy_used} ({h.attempts} attempts) - {h.succeeded ? 'SUCCESS' : 'FAILED'}
                  </span>
                ))}
              </div>
            )}
            {step.status === 'failed' && (
              <div className="trace-line">
                <span className="trace-label">Crash Telemetry:</span>
                <span className="trace-value" style={{ color: '#ef4444' }}>[{step.failure_class}] {step.error_type}</span>
              </div>
            )}
            {step.dom_candidates && step.dom_candidates.length > 0 && (
              <div className="trace-line" style={{ marginTop: '0.75rem' }}>
                <span className="trace-label">DOM Candidates ({step.dom_candidates.length} presented to LLM):</span>
                <table className="dom-candidates-table">
                  <thead>
                    <tr>
                      <th>Kaizen ID</th>
                      <th>Role</th>
                      <th>Name</th>
                      <th>Selector</th>
                    </tr>
                  </thead>
                  <tbody>
                    {step.dom_candidates.map((c, i) => {
                      const isChosen = step.llm_picked_kaizen_id != null && c.kaizenId === step.llm_picked_kaizen_id;
                      return (
                        <tr key={c.kaizenId || i} className={isChosen ? 'chosen-row' : ''}>
                          <td>
                            {c.kaizenId}
                            {isChosen && <span className="llm-pick-badge">LLM pick</span>}
                          </td>
                          <td>{c.role}</td>
                          <td>{c.name}</td>
                          <td className="selector-cell">{c.selector}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [tenantId, setTenantId] = useState(DEFAULT_TENANT_ID);
  const [apiEndpoint, setApiEndpoint] = useState('http://localhost:3000');
  const [baseUrl, setBaseUrl] = useState('https://github.com/login');
  const [steps, setSteps] = useState<string[]>(['click the Sign in button', 'type "test" in username']);
  
  const [runId, setRunId] = useState<string | null>(null);
  const [runData, setRunData] = useState<RunData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeScreenshot, setActiveScreenshot] = useState<string | null>(null);

  // Polling logic
  useEffect(() => {
    if (!runId) return;

    const poll = async () => {
      try {
        const res = await fetch(`${apiEndpoint}/runs/${runId}`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data = await res.json();
        
        setRunData(data);

        if (['passed', 'failed', 'cancelled'].includes(data.status)) {
          clearInterval(interval);
        }
      } catch (err: any) {
        console.error('Polling error:', err);
      }
    };

    poll(); // immediate first fetch
    const interval = setInterval(poll, 1500);

    return () => clearInterval(interval);
  }, [runId, apiEndpoint]);

  const handleAddStep = () => {
    setSteps([...steps, '']);
  };

  const handleStepChange = (index: number, value: string) => {
    const newSteps = [...steps];
    newSteps[index] = value;
    setSteps(newSteps);
  };

  const handleRemoveStep = (index: number) => {
    setSteps(steps.filter((_, i) => i !== index));
  };

  const handleRunSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setRunData(null);
    setRunId(null);

    const validSteps = steps.filter(s => s.trim() !== '');
    if (validSteps.length === 0) {
      setError('Please provide at least one test step.');
      setIsSubmitting(false);
      return;
    }

    try {
      const res = await fetch(`${apiEndpoint}/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tenantId,
          baseUrl,
          steps: validSteps,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to trigger run');
      }

      setRunId(data.runId);
    } catch (err: any) {
      setError(err.message || 'Network error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="app-container">
      <div className="header">
        <h1>Kaizen QA Dashboard</h1>
        <p>Visually validate and execute semantic test suites targeting the Kaizen Engine.</p>
      </div>

      <div className="panel configuration-panel">
        <h2>Test Configuration</h2>
        <form onSubmit={handleRunSubmit}>
          <div className="form-group">
            <label>API Endpoint</label>
            <input 
              type="url" 
              value={apiEndpoint}
              onChange={e => setApiEndpoint(e.target.value)}
              placeholder="http://localhost:3000"
              required 
            />
          </div>

          <div className="form-group">
            <label>Tenant ID</label>
            <input 
              type="text" 
              value={tenantId}
              onChange={e => setTenantId(e.target.value)}
              placeholder="UUID"
              required 
            />
          </div>

          <div className="form-group" style={{ marginTop: '2rem' }}>
            <label>Target Environment URL</label>
            <input 
              type="url" 
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://example.com"
              required 
            />
          </div>

          <div className="form-group">
            <label>Test Steps (Natural Language)</label>
            <div className="step-list">
              {steps.map((step, index) => (
                <div key={index} className="step-input-wrapper">
                  <input 
                    type="text" 
                    value={step}
                    onChange={(e) => handleStepChange(index, e.target.value)}
                    placeholder="e.g. click the login button"
                  />
                  {steps.length > 1 && (
                    <button 
                      type="button" 
                      className="btn-danger-icon" 
                      onClick={() => handleRemoveStep(index)}
                      title="Remove Step"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button type="button" className="btn-secondary" onClick={handleAddStep} style={{ alignSelf: 'flex-start' }}>
              + Add Step
            </button>
          </div>

          {error && <div className="error-box">{error}</div>}

          <div className="form-group" style={{ marginTop: '2rem' }}>
            <button 
              type="submit" 
              className="btn-primary" 
              disabled={isSubmitting || steps.every(s => s.trim() === '')}
            >
              {isSubmitting ? 'Starting...' : '🚀 Run Test'}
            </button>
          </div>
        </form>
      </div>

      <div className="panel results-panel">
        <h2>Execution Results</h2>
        
        {!runId && !runData && (
          <p>No active run. Configure and trigger a test to see results flowing here.</p>
        )}

        {runId && !runData && (
          <p>Connecting to backend and fetching run `{runId}`...</p>
        )}

        {runData && (
          <>
            <div className="run-details">
              <div>
                <strong>Run ID:</strong> {runData.id.slice(0, 8)}...
                <br />
                <strong>URL:</strong> <a href={runData.environment_url} target="_blank" rel="noreferrer" style={{color: 'var(--primary)'}}>{runData.environment_url}</a>
                {runData.total_tokens !== undefined && runData.total_tokens >= 0 && (
                  <>
                    <br />
                    <strong>Total Tokens Used:</strong> <span style={{ color: 'var(--warning)' }}>{runData.total_tokens.toLocaleString()}</span>
                  </>
                )}
              </div>
              <span className={`status-badge ${runData.status}`}>
                {runData.status}
              </span>
            </div>

            <div className="steps-container">
              {!runData.stepResults || runData.stepResults.length === 0 ? (
                <p>Waiting for steps to begin execution...</p>
              ) : (
                runData.stepResults.map((step, idx) => (
                  <StepCard
                    key={step.id}
                    step={step}
                    idx={idx}
                    stepText={steps[idx]}
                    apiEndpoint={apiEndpoint}
                    runId={runData.id}
                    onImageClick={setActiveScreenshot}
                    onVerdictChange={(stepId, verdict) => {
                      setRunData(prev => prev ? {
                        ...prev,
                        stepResults: prev.stepResults?.map(s =>
                          s.id === stepId ? { ...s, user_verdict: verdict } : s
                        ),
                      } : prev);
                    }}
                  />
                ))
              )}
            </div>
            
            {['passed', 'failed', 'cancelled'].includes(runData.status) && (
              <p style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.9rem' }}>
                Run {runData.status} at {new Date(runData.completed_at || '').toLocaleTimeString()}
              </p>
            )}
          </>
        )}
      </div>

      {activeScreenshot && (
        <div className="lightbox-overlay" onClick={() => setActiveScreenshot(null)}>
          <img 
            src={activeScreenshot} 
            className="lightbox-image" 
            alt="Fullscreen View" 
            onClick={(e) => e.stopPropagation()} 
          />
        </div>
      )}
    </div>
  );
}

export default App;
