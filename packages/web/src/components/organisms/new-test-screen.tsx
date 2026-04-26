'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Play, Plus, Trash2, Sparkles, Copy, Globe, Layers, Cpu,
  Eye, MousePointerClick, Type as TypeIcon, Navigation, History, Check, Loader2, Save,
} from 'lucide-react';
import { TopBar } from '@/components/organisms/app-shell/top-bar';
import { Wip } from '@/components/atoms/wip';
import { Toast } from '@/components/atoms/toast';
import { useSuites } from '@/hooks/use-suites';
import { cn } from '@/lib/cn';

type IntentKind = 'NAV' | 'TYPE' | 'CLICK' | 'ASSERT' | 'WAIT' | 'STEP';
type ToastState = { msg: string; kind: 'info' | 'success' | 'danger' } | null;

export function NewTestScreen() {
  const router = useRouter();
  const { suites } = useSuites();

  const [name, setName]       = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [suiteId, setSuiteId] = useState<string>('');
  const [steps, setSteps]     = useState<string[]>(['']);
  const [submitting, setSubmitting] = useState<null | 'save' | 'save-and-run'>(null);
  const [toast, setToast]     = useState<ToastState>(null);

  function showToast(msg: string, kind: 'info' | 'success' | 'danger' = 'info') {
    setToast({ msg, kind });
    window.setTimeout(() => setToast(null), 3000);
  }

  function validate(): string[] | null {
    if (!name.trim())    { showToast('Test name is required.', 'danger'); return null; }
    if (!baseUrl.trim()) { showToast('Target URL is required.', 'danger'); return null; }
    if (!suiteId)        { showToast('Pick a suite.', 'danger'); return null; }
    const filled = steps.map((s) => s.trim()).filter(Boolean);
    if (!filled.length)  { showToast('Add at least one step.', 'danger'); return null; }
    return filled;
  }

  /**
   * Creates the test case and returns its new ID.
   * Throws on failure — caller decides how to show errors.
   */
  async function createCase(filledSteps: string[]): Promise<string> {
    const res = await fetch(`/api/proxy/suites/${suiteId}/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), baseUrl: baseUrl.trim(), steps: filledSteps }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? body?.message ?? 'Failed to create test');
    }
    const body = (await res.json()) as { case: { id: string } };
    return body.case.id;
  }

  async function handleSave() {
    const filled = validate();
    if (!filled) return;
    setSubmitting('save');
    try {
      await createCase(filled);
      showToast('Test saved.', 'success');
      window.setTimeout(() => router.push('/tests'), 500);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Something went wrong.', 'danger');
    } finally {
      setSubmitting(null);
    }
  }

  async function handleSaveAndRun() {
    const filled = validate();
    if (!filled) return;
    setSubmitting('save-and-run');
    try {
      const caseId = await createCase(filled);

      const runRes = await fetch(`/api/proxy/cases/${caseId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!runRes.ok) {
        const body = await runRes.json().catch(() => ({}));
        if (runRes.status === 402 && body?.message) {
          showToast(body.message, 'danger');
          // Test was saved successfully even though the run couldn't start —
          // route to the detail page so the user can retry the run from there.
          window.setTimeout(() => router.push(`/tests/${caseId}`), 600);
          return;
        }
        throw new Error('Failed to enqueue run');
      }
      showToast('Test saved. Run enqueued.', 'success');
      router.push(`/tests/${caseId}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Something went wrong.', 'danger');
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <TopBar
        crumbs={[
          { label: 'Tests', href: '/tests' },
          { label: 'New' },
        ]}
      />

      <div className="px-7 pt-5 pb-4 border-b border-border-subtle flex items-center gap-3.5">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-text-mid hover:text-text-hi hover:bg-surface-elevated text-xs"
        >
          <ArrowLeft size={13} /> Back
        </button>
        <div className="flex-1">
          <div className="eyebrow mb-1">compose · plain english</div>
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-text-hi leading-none">
            New test
          </h1>
        </div>
        <button
          onClick={handleSave}
          disabled={submitting !== null}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-surface-elevated border border-border-strong text-text hover:text-text-hi disabled:opacity-60"
        >
          {submitting === 'save' ? <Loader2 size={11} className="animate-orbit" /> : <Save size={11} />}
          Save
        </button>
        <button
          onClick={handleSaveAndRun}
          disabled={submitting !== null}
          className={cn(
            'inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-semibold text-app-bg-deep',
            'bg-brand-primary disabled:opacity-60',
          )}
          style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)' }}
        >
          {submitting === 'save-and-run' ? <Loader2 size={11} className="animate-orbit" /> : <Play size={11} />}
          Save &amp; run
        </button>
      </div>

      <div className="flex-1 overflow-auto px-7 pt-6 pb-20">
        <div className="grid gap-6 max-w-[1320px] mx-auto" style={{ gridTemplateColumns: '1fr 360px' }}>
          <div className="flex flex-col gap-5">
            {/* Identity card */}
            <div className="surface bg-surface border border-border-subtle rounded-[14px] p-4.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Test name"
                className="w-full bg-transparent border-0 outline-none font-display text-[24px] font-semibold tracking-tight text-text-hi p-0"
              />
              <div className="flex flex-wrap items-center gap-4.5 mt-3 text-xs">
                <FieldRow label="Target" icon={Globe}>
                  <input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://app.example.com/login"
                    className="bg-transparent border-0 outline-none text-text font-mono text-xs min-w-[280px] placeholder:text-text-faint"
                  />
                </FieldRow>
                <FieldRow label="Suite" icon={Layers}>
                  <select
                    value={suiteId}
                    onChange={(e) => setSuiteId(e.target.value)}
                    className="bg-transparent border-0 outline-none text-text text-xs"
                  >
                    <option value="">Select…</option>
                    {suites.map((s) => (
                      <option key={s.id} value={s.id} className="bg-surface text-text">
                        {s.name}
                      </option>
                    ))}
                  </select>
                </FieldRow>
                <FieldRow label="Browser" icon={Cpu}>
                  <span className="text-xs text-text">Chromium</span>
                </FieldRow>
              </div>
            </div>

            {/* Steps composer */}
            <div className="bg-surface border border-border-subtle rounded-[14px] overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-surface-sunken">
                <div className="flex items-center gap-2.5">
                  <span className="eyebrow">spec</span>
                  <span className="text-[11px] text-text-mid">
                    Plain English. The compiler infers selectors, intent, and waits.
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <GhostMini icon={Sparkles} label="Suggest" disabled />
                  <GhostMini icon={Copy} label="Import" disabled />
                </div>
              </div>

              <div className="py-1.5">
                {steps.map((step, i) => (
                  <StepEditor
                    key={i}
                    index={i}
                    value={step}
                    onChange={(v) => setSteps((prev) => prev.map((s, j) => (j === i ? v : s)))}
                    onDelete={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
                    showCompiler={i < 2}
                  />
                ))}

                <button
                  onClick={() => setSteps((prev) => [...prev, ''])}
                  className="flex items-center gap-2.5 w-full text-left border-0 bg-transparent text-text-mid hover:text-text-hi text-xs"
                  style={{ padding: '10px 16px 12px 60px' }}
                >
                  <Plus size={12} /> Add step
                  <span className="eyebrow ml-auto pr-3">↵ enter</span>
                </button>
              </div>
            </div>

            {/* Live preview viewport */}
            <div className="bg-surface border border-border-subtle rounded-[14px] overflow-hidden">
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border-subtle bg-surface-sunken">
                <div className="flex items-center gap-2.5">
                  <div className="flex gap-1">
                    <BrowserDot /><BrowserDot /><BrowserDot />
                  </div>
                  <span className="font-mono text-[11px] text-text-mid">{baseUrl}</span>
                </div>
                <Wip label="DRY RUN WIP" />
              </div>
              <div
                className="h-[280px] grid place-items-center bg-app-bg-deep"
                style={{ backgroundImage: 'repeating-linear-gradient(45deg, var(--color-border-subtle) 0 1px, transparent 1px 14px)' }}
              >
                <div className="text-center text-text-mid">
                  <Eye size={20} className="text-text-low mx-auto" />
                  <div className="eyebrow mt-2">browser preview</div>
                  <div className="text-[11px] mt-1"><Wip /></div>
                </div>
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col gap-4">
            <CompilerCard />
            <ConfigCard />
            <CostCard />
          </div>
        </div>
      </div>

      {toast && <Toast message={toast.msg} kind={toast.kind} />}
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function FieldRow({
  label, icon: Icon, children,
}: { label: string; icon: typeof Globe; children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <Icon size={11} className="text-text-low" />
      <span className="eyebrow">{label}</span>
      {children}
    </div>
  );
}

function GhostMini({ icon: Icon, label, disabled = false }: { icon: typeof Sparkles; label: string; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      title={disabled ? 'Not wired yet' : undefined}
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-text-mid hover:text-text-hi disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Icon size={11} /> {label}
    </button>
  );
}

function BrowserDot() {
  return <span className="w-2 h-2 rounded-full bg-border-strong" />;
}

function StepEditor({
  index, value, onChange, onDelete, showCompiler,
}: {
  index: number;
  value: string;
  onChange: (v: string) => void;
  onDelete: () => void;
  showCompiler: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const intent = detectIntent(value);

  return (
    <div
      className={cn(
        'grid py-1.5 transition-colors',
        index > 0 && 'border-t border-border-subtle',
        focused && 'bg-brand-primary/[0.025]',
      )}
      style={{ gridTemplateColumns: '40px 1fr' }}
    >
      <div className="flex items-start justify-center pt-3">
        <span className="font-mono tabular text-[10px] text-text-low">
          {String(index + 1).padStart(2, '0')}
        </span>
      </div>
      <div className="pr-4 py-1.5">
        <div className="flex items-center gap-2">
          <IntentChip intent={intent} />
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Describe the action…"
            className="flex-1 bg-transparent border-0 outline-none text-text text-[13px] py-1"
          />
          <button
            onClick={onDelete}
            className="opacity-60 hover:opacity-100 text-text-mid hover:text-danger px-1.5 py-1 rounded"
            title="Remove step"
          >
            <Trash2 size={11} />
          </button>
        </div>
        {focused && showCompiler && (
          <div
            className="animate-modal-pop mt-2 px-2.5 py-2 bg-surface-sunken rounded-md text-[11px] text-text-mid flex items-center gap-2"
            style={{ border: '1px solid var(--color-border-accent)' }}
          >
            <Sparkles size={11} className="text-brand-primary" />
            <span>Compiler resolution:</span>
            <Wip />
          </div>
        )}
      </div>
    </div>
  );
}

function IntentChip({ intent }: { intent: ReturnType<typeof detectIntent> }) {
  const Icon = intent.icon;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[9px] uppercase font-semibold tracking-[0.1em] border"
      style={{ color: intent.color, borderColor: intent.border, background: intent.bg }}
    >
      <Icon size={9} /> {intent.label}
    </span>
  );
}

type Intent = {
  kind: IntentKind;
  label: IntentKind;
  icon: typeof Navigation;
  color: string;
  border: string;
  bg: string;
};

function detectIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (t.startsWith('navig') || t.includes('go to') || t.includes('open ')) {
    return { kind: 'NAV', label: 'NAV', icon: Navigation, color: 'var(--color-brand-accent)', border: 'rgba(219,135,175,0.3)', bg: 'rgba(219,135,175,0.08)' };
  }
  if (t.startsWith('type') || t.startsWith('enter ') || t.startsWith('fill')) {
    return { kind: 'TYPE', label: 'TYPE', icon: TypeIcon, color: 'var(--color-brand-primary)', border: 'rgba(213,96,28,0.3)', bg: 'rgba(213,96,28,0.08)' };
  }
  if (t.startsWith('click') || t.startsWith('press') || t.startsWith('tap')) {
    return { kind: 'CLICK', label: 'CLICK', icon: MousePointerClick, color: 'var(--color-brand-primary)', border: 'rgba(213,96,28,0.3)', bg: 'rgba(213,96,28,0.08)' };
  }
  if (t.startsWith('verify') || t.startsWith('expect') || t.startsWith('check') || t.startsWith('assert')) {
    return { kind: 'ASSERT', label: 'ASSERT', icon: Check, color: 'var(--color-success)', border: 'rgba(34,197,94,0.3)', bg: 'rgba(34,197,94,0.08)' };
  }
  if (t.startsWith('wait')) {
    return { kind: 'WAIT', label: 'WAIT', icon: History, color: 'var(--color-warning)', border: 'rgba(245,158,11,0.3)', bg: 'rgba(245,158,11,0.08)' };
  }
  return { kind: 'STEP', label: 'STEP', icon: Cpu, color: 'var(--color-text-mid)', border: 'var(--color-border-subtle)', bg: 'var(--color-surface-sunken)' };
}

// ─── Right-column cards (compiler / config / cost) ──────────────────────────

function CompilerCard() {
  return (
    <div className="bg-surface border border-border-subtle rounded-[14px] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Cpu size={13} className="text-brand-primary" />
        <span className="eyebrow">compiler</span>
        <div className="flex-1" />
        <Wip />
      </div>
      <div className="text-xs text-text-mid leading-relaxed mb-3">
        Realtime compile metrics not wired yet.
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Mini2 label="LLM tokens" />
        <Mini2 label="Compile time" />
      </div>
    </div>
  );
}

function ConfigCard() {
  return (
    <div className="bg-surface border border-border-subtle rounded-[14px] p-4 flex flex-col gap-3">
      <div className="eyebrow">configuration</div>
      <Toggle label="Self-heal selectors" desc="Recover when DOM drifts" defaultOn />
      <Toggle label="Capture screenshots" desc="On every step" defaultOn />
      <Toggle label="Record video" desc="Trace.zip download" />
      <Toggle label="Run on save" desc="Trigger on every commit" defaultOn />
    </div>
  );
}

function Toggle({ label, desc, defaultOn = false }: { label: string; desc: string; defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        onClick={() => setOn((v) => !v)}
        className={cn(
          'w-7 h-4 rounded-full relative transition-all',
          on ? 'bg-brand-primary' : 'bg-border-strong',
        )}
        style={on ? { boxShadow: '0 0 8px var(--color-brand-primary-glow)' } : undefined}
        aria-pressed={on}
        aria-label={label}
      >
        <span
          className="absolute top-0.5 w-3 h-3 rounded-full transition-all"
          style={{
            left: on ? 14 : 2,
            background: on ? 'var(--color-app-bg-deep)' : 'var(--color-text-mid)',
          }}
        />
      </button>
      <div className="flex-1">
        <div className="text-xs text-text-hi font-medium">{label}</div>
        <div className="text-[11px] text-text-low">{desc}</div>
      </div>
    </div>
  );
}

function CostCard() {
  return (
    <div className="bg-surface border border-border-subtle rounded-[14px] p-4">
      <div className="eyebrow mb-2">est. cost per run</div>
      <div className="flex items-baseline gap-2">
        <span className="font-display tabular text-[24px] font-semibold text-text-hi">
          <Wip />
        </span>
        <span className="text-[11px] text-text-low">/ run</span>
      </div>
      <div className="text-[11px] text-text-mid mt-1">
        Estimate not wired yet.
      </div>
    </div>
  );
}

function Mini2({ label }: { label: string }) {
  return (
    <div className="p-2 rounded-md bg-surface-sunken">
      <div className="eyebrow !text-[9px] mb-0.5">{label}</div>
      <div className="font-mono tabular text-[13px] text-text-hi font-medium"><Wip /></div>
    </div>
  );
}
