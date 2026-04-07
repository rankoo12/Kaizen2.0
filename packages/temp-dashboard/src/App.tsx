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

interface StepResult {
  id: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  raw_text?: string;
  cache_hit: boolean;
  duration_ms?: number;
  error_type?: string;
  failure_class?: string;
  screenshot_key?: string;
  selector_used?: string;
  healingEvents: HealingEvent[];
  tokens?: number;
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

function StepCard({ step, idx, stepText, apiEndpoint, onImageClick }: { step: StepResult, idx: number, stepText: string, apiEndpoint: string, onImageClick: (url: string) => void }) {
  const [traceOpen, setTraceOpen] = useState(false);

  return (
    <div className={`step-card ${step.status}`}>
      <div className="step-header">
        <span className="step-text">
          {idx + 1}. {stepText || 'Unknown Step'}
        </span>
        <span className={`status-badge ${step.status}`} style={{ fontSize: '0.7em', padding: '0.1rem 0.5rem' }}>
          {step.status}
        </span>
      </div>

      {(step.duration_ms || step.cache_hit || step.tokens !== undefined) && (
        <div className="step-meta">
          {step.duration_ms !== undefined && (
            <span className="meta-item">⏱ {step.duration_ms}ms</span>
          )}
          {step.tokens !== undefined && step.tokens > 0 && (
            <span className="meta-item">🪙 {step.tokens} tokens</span>
          )}
          {step.cache_hit && (
            <span className="meta-item cache-hit">⚡ Cache Hit</span>
          )}
          {!step.cache_hit && step.status !== 'pending' && step.status !== 'skipped' && (
            <span className="meta-item">🤖 LLM Resolved</span>
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

      <div style={{ marginTop: '1rem' }}>
        <button className="btn-trace-toggle" onClick={() => setTraceOpen(!traceOpen)}>
          {traceOpen ? '▼ Hide Execution Trace' : '▶ View Execution Trace'}
        </button>
        {traceOpen && (
          <div className="trace-terminal">
            <div className="trace-line">
              <span className="trace-label">Resolution Origin:</span>
              <span className="trace-value">{step.cache_hit ? 'O(1) Hash Cache Semantic Hit' : 'OpenAI Model Interpretation'}</span>
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
                    onImageClick={setActiveScreenshot} 
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
