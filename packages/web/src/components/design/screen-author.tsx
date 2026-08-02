'use client';
/* New test — design markup from `Kaizen (1)/native/screen-author.jsx`, wired to the real
   create flow (POST /suites, POST /suites/:id/cases, POST /cases/:id/run).

   Two things the design faked are handled honestly here:
   · The suite picker reads real suites and can create one inline (the API has no
     "default suite", so a first-time workspace needs this to save anything at all).
   · The compile preview no longer consults a mock brain. Verb parsing is real (it's
     derived from the text), but whether a lookup hits memory is only knowable at run
     time, so steps are split into "needs no lookup" (navigation/waits — genuinely 0
     tokens) and "needs a lookup", with no invented token estimate.
   Dropped rather than faked: the CI-on-push toggle and "Save draft" (no endpoints). */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';
import { I } from './icons';
import { Toolbar, SourceTag } from './chrome';
import type { DesignSuite } from './use-design-data';

const { useState: uSa, useMemo: uMa, useEffect: uEa } = React;

const VERBS: [string, string][] = [
  ['navigate', 'Navigate'], ['go to', 'Navigate'], ['open', 'Navigate'], ['reload', 'Navigate'], ['go back', 'Navigate'],
  ['type', 'Type'], ['enter', 'Type'], ['fill', 'Type'],
  ['click', 'Click'], ['double-click', 'Click'], ['right-click', 'Click'], ['press', 'Key'],
  ['select', 'Select'], ['choose', 'Select'], ['check', 'Check'], ['uncheck', 'Check'],
  ['drag', 'Drag'], ['drop', 'Drag'], ['scroll', 'Scroll'], ['wait', 'Wait'],
  ['switch to', 'Tabs'], ['close the tab', 'Tabs'], ['dismiss', 'Click'],
  ['verify', 'Assert'], ['assert', 'Assert'], ['expect', 'Assert'], ['confirm', 'Assert'],
  ['remember', 'Capture'], ['capture', 'Capture'],
];

/** Steps that act on the page itself rather than on an element never cost tokens. */
const NO_LOOKUP = /^(navigate|go to|open |reload|wait|scroll|press|go back)/;

export function parseStep(text: string): { verb: string; lookup: boolean } {
  const t = text.trim().toLowerCase();
  if (!t) return { verb: '—', lookup: false };
  const hit = VERBS.find(([k]) => t.startsWith(k)) || VERBS.find(([k]) => t.includes(` ${k} `));
  return { verb: hit ? hit[1] : 'Click', lookup: !NO_LOOKUP.test(t) };
}

/** Skeletons the user edits — built off whatever URL is in the field, not a fake domain. */
function starters(url: string): Record<string, string[]> {
  const u = url.trim() || 'https://';
  return {
    'Sign-in flow': [
      `navigate to ${u}`,
      'dismiss the cookie banner if it appears',
      'type your email in the email field',
      'type your password in the password field',
      'click the "Sign in" button',
      'verify the page contains "Dashboard"',
    ],
    'Search a site': [
      `navigate to ${u}`,
      'type "hello" in the search box',
      'press Enter',
      'verify the results list is not empty',
    ],
    Blank: [`navigate to ${u}`],
  };
}

function StepEditor({ steps, setSteps }: { steps: string[]; setSteps: (s: string[]) => void }) {
  const [focus, setFocus] = uSa<number | null>(null);
  const move = (i: number, d: number) => {
    const n = [...steps]; const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]]; setSteps(n);
  };
  return (
    <div className="list">
      <div className="list-h">
        <span style={{ flex: 1 }}>STEPS · PLAIN ENGLISH, IN ORDER</span>
        <span className="num">{steps.length}</span>
      </div>
      {steps.map((s, i) => {
        const p = parseStep(s);
        return (
          <div className="row" key={i} style={{ cursor: 'default', alignItems: 'center', padding: '7px 10px 7px 8px', background: focus === i ? 'var(--fill)' : undefined }}>
            <I.drag size={13} style={{ color: 'var(--text-3)', flex: 'none' }} />
            <span className="num" style={{ fontSize: 11, color: 'var(--text-3)', width: 15, flex: 'none' }}>{i + 1}</span>
            <span className="mono-chip hide-sm" style={{ width: 60, flex: 'none', textAlign: 'center', fontSize: 11, fontWeight: 700, letterSpacing: '.03em', color: p.verb === '—' ? 'var(--text-3)' : 'var(--text-2)' }}>{p.verb.toUpperCase()}</span>
            <input className="field" value={s} onFocus={() => setFocus(i)} onBlur={() => setFocus(null)}
              onChange={(e) => { const n = [...steps]; n[i] = e.target.value; setSteps(n); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const n = [...steps]; n.splice(i + 1, 0, ''); setSteps(n);
                  setTimeout(() => {
                    const inputs = (e.target as HTMLElement).closest('.list')?.querySelectorAll('input.field');
                    (inputs?.[i + 1] as HTMLInputElement | undefined)?.focus();
                  }, 0);
                }
              }}
              placeholder="e.g. click the “Sign in” button"
              style={{ height: 26, border: 'none', background: 'transparent', boxShadow: 'none', fontSize: 13, flex: 1, minWidth: 0, padding: '0 2px' }} />
            <div style={{ display: 'flex', gap: 1, flex: 'none' }}>
              <button className="btn icon ghost" onClick={() => move(i, -1)} disabled={!i} title="Move up"><I.chevronUp size={12} /></button>
              <button className="btn icon ghost" onClick={() => move(i, 1)} disabled={i === steps.length - 1} title="Move down"><I.chevronDown size={12} /></button>
              <button className="btn icon ghost" onClick={() => setSteps(steps.filter((_, k) => k !== i))} title="Remove"><I.x size={12} /></button>
            </div>
          </div>
        );
      })}
      <div className="row" style={{ padding: '8px 12px' }} onClick={() => setSteps([...steps, ''])}>
        <I.plus size={13} style={{ color: 'var(--accent)' }} />
        <span style={{ fontSize: 13, color: 'var(--accent-text)', fontWeight: 500 }}>Add a step</span>
      </div>
    </div>
  );
}

export function AuthorScreen({ suites, defaultSuiteId, editCaseId, onBack, onCreated, onSuitesChanged, showToast }: {
  suites: DesignSuite[];
  defaultSuiteId?: string | null;
  /** When set, the screen edits that test instead of creating a new one. */
  editCaseId?: string | null;
  onBack: () => void;
  /** Called with the new case id, and the run id when the run was enqueued. */
  onCreated: (caseId: string, runId: string | null) => void;
  onSuitesChanged: () => void;
  showToast: (msg: string, kind?: string) => void;
}) {
  const [name, setName] = uSa('');
  const [url, setUrl] = uSa('https://');
  const [suiteId, setSuiteId] = uSa(defaultSuiteId || suites[0]?.id || '');
  const [steps, setSteps] = uSa<string[]>(['navigate to https://']);
  const [busy, setBusy] = uSa<null | 'save' | 'run'>(null);
  const [newSuite, setNewSuite] = uSa<string | null>(null);
  const [loading, setLoading] = uSa(!!editCaseId);

  /* Edit mode: pull the test's current definition in. Steps come back positioned, so the
     editor opens on exactly what will run. */
  uEa(() => {
    if (!editCaseId) return;
    let alive = true;
    setLoading(true);
    fetch(`/api/proxy/cases/${editCaseId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((b) => {
        if (!alive) return;
        const c = b.case ?? b;
        setName(c.name ?? '');
        setUrl(c.baseUrl ?? c.base_url ?? 'https://');
        if (c.suiteId ?? c.suite_id) setSuiteId(c.suiteId ?? c.suite_id);
        const raw = (c.steps ?? []).map((x: any) => x.rawText ?? x.raw_text ?? '').filter(Boolean);
        if (raw.length) setSteps(raw);
      })
      .catch(() => showToast('Could not load the test', 'error'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [editCaseId]);

  const plan = uMa(() => steps.map((s, i) => ({ i: i + 1, text: s, ...parseStep(s) })), [steps]);
  const filled = plan.filter((p) => p.text.trim());
  const lookups = filled.filter((p) => p.lookup).length;

  async function createSuite() {
    const n = (newSuite || '').trim();
    if (!n) return;
    try {
      const r = await fetch('/api/proxy/suites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }),
      });
      if (!r.ok) throw new Error();
      const b = await r.json();
      setSuiteId(b.suite.id);
      setNewSuite(null);
      onSuitesChanged();
      showToast(`Suite “${n}” created`, 'success');
    } catch {
      showToast('Could not create the suite', 'error');
    }
  }

  function validate(): string[] | null {
    if (!name.trim()) { showToast('Give the test a name', 'error'); return null; }
    if (!/^https?:\/\/.+/.test(url.trim())) { showToast('Target URL needs to start with http:// or https://', 'error'); return null; }
    if (!suiteId) { showToast('Pick a suite, or create one', 'error'); return null; }
    const s = steps.map((x) => x.trim()).filter(Boolean);
    if (!s.length) { showToast('Write at least one step', 'error'); return null; }
    return s;
  }

  async function save(andRun: boolean) {
    const s = validate();
    if (!s) return;
    setBusy(andRun ? 'run' : 'save');
    try {
      /* PATCH /cases/:id replaces the step list under the versioning protocol, so an
         edited test keeps its identity, its run history and everything the brain has
         learned for the steps that didn't change. */
      const res = editCaseId
        ? await fetch(`/api/proxy/cases/${editCaseId}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim(), baseUrl: url.trim(), steps: s }),
          })
        : await fetch(`/api/proxy/suites/${suiteId}/cases`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name.trim(), baseUrl: url.trim(), steps: s }),
          });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.message ?? b?.error ?? 'Could not save the test');
      }
      const caseId = editCaseId ?? ((await res.json()).case.id as string);

      if (!andRun) {
        showToast(editCaseId ? 'Changes saved' : 'Test saved', 'success');
        onCreated(caseId, null);
        return;
      }

      const runRes = await fetch(`/api/proxy/cases/${caseId}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!runRes.ok) {
        const b = await runRes.json().catch(() => ({}));
        // The test itself saved — say so, and still open it so the run can be retried.
        showToast(b?.message || 'Test saved, but the run could not start', 'error');
        onCreated(caseId, null);
        return;
      }
      const runId = (await runRes.json()).runId as string;
      showToast('Saved — booting a browser', 'success');
      onCreated(caseId, runId);
    } catch (err: any) {
      showToast(err?.message || 'Something went wrong', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Toolbar back={onBack}
        title={editCaseId ? (name || 'Edit test') : 'New test'}
        sub={editCaseId
          ? 'Editing the steps. Run history and learned selectors are kept.'
          : 'Write it in English — Kaizen finds the elements at run time'}>
        <button className="btn" onClick={onBack}>Cancel</button>
        <button className="btn" onClick={() => save(false)} disabled={!!busy}>
          {busy === 'save' ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null}Save
        </button>
        <button className="btn pri" onClick={() => save(true)} disabled={!!busy || !filled.length}>
          {busy === 'run' ? <span className="spinner" style={{ width: 11, height: 11, borderTopColor: '#fff' }} /> : <I.play size={12} />}Save &amp; Run
        </button>
      </Toolbar>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="scroll" style={{ flex: 1, padding: '18px 22px 40px', minWidth: 0 }}>
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 14 }}>
              <label>
                <div className="label">Test name</div>
                <input className="field" style={{ marginTop: 5 }} value={name} autoFocus
                  placeholder="Sign in with valid credentials"
                  onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                <div className="label">Suite</div>
                {newSuite !== null ? (
                  <div style={{ display: 'flex', gap: 5, marginTop: 5 }}>
                    <input className="field" autoFocus value={newSuite} placeholder="New suite name"
                      onChange={(e) => setNewSuite(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') createSuite(); if (e.key === 'Escape') setNewSuite(null); }} />
                    <button className="btn icon" title="Create suite" onClick={createSuite} disabled={!newSuite.trim()}><I.check size={13} /></button>
                    <button className="btn icon ghost" title="Cancel" onClick={() => setNewSuite(null)}><I.x size={13} /></button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 5, marginTop: 5 }}>
                    <select className="field" value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
                      {!suites.length && <option value="">No suites yet</option>}
                      {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <button className="btn icon" title="New suite" onClick={() => setNewSuite('')}><I.plus size={13} /></button>
                  </div>
                )}
              </label>
            </div>
            <label style={{ display: 'block', marginTop: 14 }}>
              <div className="label">Target URL</div>
              <input className="field num" style={{ marginTop: 5 }} value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 8px', flexWrap: 'wrap' }}>
            <span className="label">Start from</span>
            {Object.entries(starters(url)).map(([k, v]) => (
              <button key={k} className="btn" style={{ height: 23, fontSize: 12 }} onClick={() => setSteps(v)}>{k}</button>
            ))}
          </div>

          <StepEditor steps={steps} setSteps={setSteps} />

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 13, padding: '0 4px' }}>
            <I.info size={13} style={{ color: 'var(--text-3)', marginTop: 2, flex: 'none' }} />
            <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.55, maxWidth: 620 }}>
              No selectors, no waits, no code. You can reference something an earlier step remembered with
              <span className="num" style={{ margin: '0 3px' }}>{'{{name}}'}</span>, and steps that touch cookie banners or iframes are handled for you.
            </div>
          </div>
        </div>

        {/* compile preview */}
        <div className="scroll inspector" style={{ flex: 'none', borderLeft: '.5px solid var(--sep)', background: 'var(--content)', padding: '16px 16px 40px' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>What Kaizen will do</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
            Read straight from your steps. Only the element lookups can ever cost tokens.
          </div>

          <div style={{ display: 'flex', gap: 9, margin: '14px 0' }}>
            <div style={{ flex: 1, background: 'var(--cache-soft)', borderRadius: 9, padding: '10px 12px' }}>
              <div className="num" style={{ fontSize: 21, fontWeight: 600, color: 'var(--cache)' }}>{filled.length - lookups}</div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 1 }}>need no lookup</div>
            </div>
            <div style={{ flex: 1, background: 'var(--warn-soft)', borderRadius: 9, padding: '10px 12px' }}>
              <div className="num" style={{ fontSize: 21, fontWeight: 600, color: 'var(--warn)' }}>{lookups}</div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 1 }}>find an element</div>
            </div>
          </div>

          <div style={{ background: 'var(--fill)', borderRadius: 9, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 9 }}>
            <I.bolt size={14} style={{ color: 'var(--text-2)', flex: 'none' }} />
            <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.45 }}>
              A lookup on a page Kaizen already knows costs <span className="num" style={{ fontWeight: 600, color: 'var(--cache)' }}>0</span>.
              Anything new goes to the AI once, then settles there too. You&rsquo;ll see the real cost per step after the first run.
            </div>
          </div>

          <div className="label" style={{ marginTop: 18, marginBottom: 7 }}>Compiled plan</div>
          {!filled.length && <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Write a step and it shows up here.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filled.map((p) => (
              <div key={p.i} style={{ border: '.5px solid var(--sep)', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="num" style={{ fontSize: 11, color: 'var(--text-3)' }}>{String(p.i).padStart(2, '0')}</span>
                  <span className="mono-chip" style={{ fontSize: 11, fontWeight: 700 }}>{p.verb.toUpperCase()}</span>
                  <div style={{ flex: 1 }} />
                  {p.lookup
                    ? <span className="badge" style={{ background: 'var(--fill)', color: 'var(--text-2)', gap: 5 }}>
                        <span className="dot" style={{ width: 5, height: 5, background: 'var(--text-3)' }} />LOOKUP
                      </span>
                    : <SourceTag source="pattern" tokens={0} />}
                </div>
                <div style={{ fontSize: 12, marginTop: 5, color: 'var(--text-2)', lineHeight: 1.4 }}>{p.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
