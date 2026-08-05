/**
 * Screenshot-based visual validation — the "QA looks at the screen" layer.
 *
 * The oracle (verdict / selectors / tokens / must-learn) proves Kaizen's INTERNAL
 * signal. This proves the EXTERNAL truth: a vision model looks at the frame taken right
 * after the test's assertion and judges, like a human QA, whether that specific claim is
 * true on screen. Layered on top of the oracle — the gold signal is DISAGREEMENT:
 *   · oracle red  + visual green → the app did the right thing but an assertion mis-fired
 *   · oracle green + visual red  → a false pass (the one thing a QA tool must never do)
 *
 * What a single screenshot CAN'T judge is skipped rather than guessed at (→ no false
 * divergence): URL/title claims (no address bar in the frame) and negative tests (proving
 * absence visually is unreliable; the oracle's must-fail logic is authoritative there).
 *
 * Cost-aware: one image per test (the assertion frame), low temperature, gpt-4o-mini
 * vision. Configurable via env (BENCH_VISUAL_MODEL / _DETAIL).
 */
import { Storage } from '@google-cloud/storage';
import OpenAI from 'openai';
import { readFileSync, existsSync } from 'fs';
import type { BenchmarkTest, RunResult, StepResult, VisualVerdict } from './types';

/** process.env wins; fall back to .env so the validator works regardless of how bench was launched. */
function loadEnv(): Record<string, string> {
  const merged: Record<string, string> = { ...(process.env as Record<string, string>) };
  try {
    if (existsSync('.env')) {
      for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
        if (!line || line.trimStart().startsWith('#') || !line.includes('=')) continue;
        const i = line.indexOf('=');
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (merged[k] == null || merged[k] === '') merged[k] = v;
      }
    }
  } catch { /* ignore */ }
  return merged;
}

const ENV = loadEnv();
const BUCKET = ENV.GCS_BUCKET ?? 'kaizen-screenshots';
const KEYFILE = ENV.GCS_KEY_FILE ?? ENV.GOOGLE_APPLICATION_CREDENTIALS;
const MODEL = ENV.BENCH_VISUAL_MODEL ?? 'gpt-4o-mini';
const DETAIL = (ENV.BENCH_VISUAL_DETAIL ?? 'high') as 'low' | 'high' | 'auto';

export function visualEnabled(): boolean {
  return !!ENV.OPENAI_API_KEY;
}

let _storage: Storage | null = null;
const gcs = () => (_storage ??= new Storage(KEYFILE ? { keyFilename: KEYFILE } : {}));
let _openai: OpenAI | null = null;
const ai = () => (_openai ??= new OpenAI({ apiKey: ENV.OPENAI_API_KEY }));

async function fetchShot(key: string | null): Promise<Buffer | null> {
  if (!key) return null;
  try {
    if (key.startsWith('gs://')) {
      const obj = key.replace(`gs://${BUCKET}/`, '');
      const [buf] = await gcs().bucket(BUCKET).file(obj).download();
      return buf;
    }
    if (existsSync(key)) return readFileSync(key);
  } catch { /* fall through */ }
  return null;
}

const ASSERTION_RE = /^\s*(verify|assert|confirm|ensure|check that)\b/i;
/** A claim about the URL or page title can't be judged from a screenshot (no address bar). */
const NOT_VISIBLE_RE = /\burl\b|\btitle\b/i;

/** Indices of steps that are assertions ("verify …"), in order. */
function assertionIndices(test: BenchmarkTest): number[] {
  const idxs: number[] = [];
  test.steps.forEach((s, i) => { if (ASSERTION_RE.test(s)) idxs.push(i); });
  return idxs;
}

/**
 * The step whose frame we judge, and the specific claim we judge it against. Prefer the
 * LAST ASSERTION step (its "after" frame is where the check is evaluated) — not merely the
 * last executed step, which for a multi-tab/cleanup flow is unrelated to the assertion.
 * Falls back to the last non-skipped frame when a test has no explicit verify.
 */
function pickFocus(test: BenchmarkTest, run: RunResult): { idx: number; step: StepResult; claim: string } | null {
  const asserts = assertionIndices(test);
  for (let k = asserts.length - 1; k >= 0; k--) {
    const i = asserts[k];
    const sr = run.steps.find((s) => s.index === i && s.shot);
    if (sr) return { idx: i, step: sr, claim: test.steps[i] };
  }
  const withShot = run.steps.filter((s) => s.shot && s.status !== 'skipped');
  const last = withShot[withShot.length - 1];
  return last ? { idx: last.index, step: last, claim: test.steps[last.index] ?? test.name } : null;
}

const SYSTEM =
  'You are a meticulous QA engineer checking ONE specific claim about a web page by looking at a ' +
  'screenshot taken right after that step ran. Judge only what is visible. Ignore unrelated overlays, ' +
  'popups or calendars unless the claim is about them. If the claim is clearly true on screen, pass; ' +
  'if it is clearly false or simply not shown, fail. Answer only in JSON.';

function buildPrompt(test: BenchmarkTest, focus: { idx: number; claim: string }): string {
  const steps = test.steps.map((s, i) => `  ${i}. ${s}${i === focus.idx ? '   ← screenshot is right after this step' : ''}`).join('\n');
  return [
    `Test: ${test.name}`,
    `Steps executed:`,
    steps,
    ``,
    `The ONE claim to validate from the screenshot:`,
    `  "${focus.claim}"`,
    ``,
    `Is that specific claim TRUE in the screenshot? Focus only on it — the right item(s)/count shown,`,
    `the right selection or toggle state, or the expected text present. Ignore anything the claim doesn't mention.`,
    ``,
    `Reply with EXACTLY this JSON: {"pass": <true|false>, "confidence": <0..1>, "observed": "<=1 sentence", "reason": "<=1 sentence"}`,
  ].join('\n');
}

/** Run one visual verdict for a test against a completed run. Never throws. */
export async function validateVisually(test: BenchmarkTest, run: RunResult): Promise<VisualVerdict> {
  const base: VisualVerdict = { ran: false, pass: null, reason: '', stepIndex: null };
  if (!visualEnabled()) return { ...base, reason: 'no OPENAI_API_KEY' };

  const focus = pickFocus(test, run);
  if (!focus) return { ...base, reason: 'no outcome screenshot captured' };

  // Skip what a single frame genuinely can't adjudicate — don't manufacture a divergence.
  if (test.category === 'adversarial-negative')
    return { ...base, reason: 'negative test — oracle authoritative', stepIndex: focus.idx };
  if (NOT_VISIBLE_RE.test(focus.claim))
    return { ...base, reason: 'url/title claim — not visible in a screenshot', stepIndex: focus.idx };

  const png = await fetchShot(focus.step.shot);
  if (!png) return { ...base, reason: 'screenshot fetch failed', stepIndex: focus.idx, error: focus.step.shot ?? undefined };

  try {
    const resp = await ai().chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt(test, focus) },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}`, detail: DETAIL } },
          ] as unknown as string,
        },
      ],
    });
    const raw = resp.choices[0]?.message?.content ?? '{}';
    const j = JSON.parse(raw) as { pass?: unknown; confidence?: unknown; observed?: unknown; reason?: unknown };
    return {
      ran: true,
      pass: typeof j.pass === 'boolean' ? j.pass : null,
      confidence: typeof j.confidence === 'number' ? j.confidence : undefined,
      observed: j.observed != null ? String(j.observed).slice(0, 200) : undefined,
      reason: String(j.reason ?? '').slice(0, 200),
      stepIndex: focus.idx,
    };
  } catch (e: unknown) {
    return { ...base, reason: 'vision call failed', stepIndex: focus.idx, error: (e as Error)?.message ?? String(e) };
  }
}
