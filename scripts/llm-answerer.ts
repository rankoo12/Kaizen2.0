/**
 * HEADLESS INBOX ANSWERER — replaces the interactive "endpoint Claude" window.
 *
 * Watches .kaizen-llm/pending/ and answers each prompt with a one-shot
 * `claude -p` invocation: a fresh process per prompt, no accumulated
 * conversation context, so there is nothing to /compact and no session to
 * stall mid-run. Answers land in .kaizen-llm/answers/<id>.json exactly as the
 * interactive window wrote them; scripts/llm-inbox.ts notices and completes
 * the HTTP request. Local development only.
 *
 *   npx tsx scripts/llm-answerer.ts
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(process.cwd(), '.kaizen-llm');
const DIRS = {
  pending: join(ROOT, 'pending'),
  answers: join(ROOT, 'answers'),
};
for (const dir of Object.values(DIRS)) mkdirSync(dir, { recursive: true });

const POLL_MS = 1_000;
const MAX_CONCURRENT = Number(process.env.ANSWERER_CONCURRENCY ?? '4');
/** A single answer should never take this long; kill and retry once. */
const ANSWER_TIMEOUT_MS = 8 * 60_000;

type Pending = {
  id: number;
  purpose: string;
  response_format: string;
  system: string;
  user: string;
};

const inFlight = new Set<number>();
const failedOnce = new Set<number>();

function buildPrompt(p: Pending): string {
  const jsonTail = p.response_format === 'json_object' || /json/iu.test(p.system)
    ? 'Respond with VALID JSON ONLY — no prose before or after, no markdown fences.'
    : 'Respond with the answer content only — no preamble, no commentary.';
  return [
    p.system,
    p.user,
    `IMPORTANT: You are answering an automated pipeline, not a person. ${jsonTail}`,
  ].filter(Boolean).join('\n\n');
}

function answerOne(file: string, p: Pending): void {
  inFlight.add(p.id);
  const started = Date.now();
  // Bulk pipeline prompts run on a low-cost model; the pipeline's gates and
  // the engine audit are the quality floor, not the answerer's model tier.
  const model = process.env.ANSWERER_MODEL ?? 'sonnet';
  const child = spawn('claude', ['-p', '--model', model, '--output-format', 'text'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { err += String(chunk); });

  const killer = setTimeout(() => { child.kill(); }, ANSWER_TIMEOUT_MS);
  child.on('close', (code) => {
    clearTimeout(killer);
    inFlight.delete(p.id);
    const answer = out.trim();
    const seconds = Math.round((Date.now() - started) / 1000);
    if (code === 0 && answer) {
      // Atomic write: the inbox reads the file the moment it exists.
      const tmp = join(DIRS.answers, `${p.id}.tmp`);
      writeFileSync(tmp, answer);
      renameSync(tmp, join(DIRS.answers, `${p.id}.json`));
      process.stdout.write(`[answerer] #${p.id} ${p.purpose} answered in ${seconds}s (${answer.length} chars)\n`);
      return;
    }
    process.stdout.write(`[answerer] #${p.id} ${p.purpose} FAILED after ${seconds}s (exit ${code}): ${err.slice(0, 200)}\n`);
    if (failedOnce.has(p.id)) {
      // Second failure: leave the pending file; a human can look. The
      // pipeline's own containment declines the one item and moves on
      // only when an answer arrives, so surface loudly.
      process.stdout.write(`[answerer] #${p.id} left unanswered after two attempts — inspect ${file}\n`);
    } else {
      failedOnce.add(p.id);   // picked up again on the next scan
    }
  });

  child.stdin.write(buildPrompt(p));
  child.stdin.end();
}

function scan(): void {
  let files: string[];
  try {
    files = readdirSync(DIRS.pending)
      .filter((f) => f.endsWith('.json'))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  } catch { return; }
  for (const f of files) {
    if (inFlight.size >= MAX_CONCURRENT) return;
    const path = join(DIRS.pending, f);
    let p: Pending;
    try { p = JSON.parse(readFileSync(path, 'utf8')) as Pending; } catch { continue; }
    if (inFlight.has(p.id)) continue;
    if (existsSync(join(DIRS.answers, `${p.id}.json`))) continue;
    answerOne(path, p);
  }
}

process.stdout.write(`[answerer] watching ${DIRS.pending} — one-shot claude -p per prompt, concurrency ${MAX_CONCURRENT}\n`);
setInterval(scan, POLL_MS);
scan();
