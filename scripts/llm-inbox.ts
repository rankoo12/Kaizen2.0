/**
 * The LLM inbox — an OpenAI-compatible local server whose "model" is whoever
 * answers the files. Local development only.
 * Spec: docs/specs/test-writer/spec-llm-inbox.md
 *
 *   npx tsx scripts/llm-inbox.ts serve [--port 4141]     # run the server
 *   npx tsx scripts/llm-inbox.ts list                    # what is waiting
 *   npx tsx scripts/llm-inbox.ts answer <id> <file>      # copy a file in as the answer
 *
 * Point the stack at it with OPENAI_BASE_URL=http://host.docker.internal:4141/v1
 * in the gitignored .env (containers) — the SDK reads that variable itself, so
 * no product code changes.
 *
 * Chat completions: cache hit → immediate; miss → prompt written to
 * .kaizen-llm/pending/<id>.json, request held until .kaizen-llm/answers/<id>.json
 * exists. Embeddings: deterministic 1536-dim unit vector from the input's hash.
 */
import { createHash } from 'crypto';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

const ROOT = join(process.cwd(), '.kaizen-llm');
const DIRS = {
  pending: join(ROOT, 'pending'),
  answers: join(ROOT, 'answers'),
  cache: join(ROOT, 'cache'),
  done: join(ROOT, 'done'),
};
for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });

type ChatRequest = {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type?: string };
};

function hashRequest(req: ChatRequest): string {
  const norm = JSON.stringify({
    model: req.model ?? '', rf: req.response_format?.type ?? 'text',
    messages: req.messages.map((m) => ({ r: m.role, c: normalise(String(m.content ?? '')) })),
  });
  return createHash('sha256').update(norm).digest('hex').slice(0, 24);
}

/** UUIDs and timestamps vary run to run; the meaning of a prompt does not. */
function normalise(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>');
}

function purposeOf(system: string): string {
  // The test-writer gateway does not name its purpose in the prompt; infer from
  // the opening words, which are stable per call site.
  const s = system.slice(0, 200);
  if (/senior QA engineer\. You have opened each of the pages/.test(s)) return 'planPageBatch';
  if (/convert ONE planned test scenario/.test(s)) return 'generateScenario';
  if (/principal QA reviewer|judge/i.test(s)) return 'judgeScenarios';
  if (/classif/i.test(s)) return 'classifyPage';
  if (/brief/i.test(s)) return 'synthesizeAppBrief';
  if (/compile|StepAST|step into/i.test(s)) return 'compileStep';
  if (/resolve|candidate/i.test(s)) return 'resolveElement';
  return 'unknown';
}

let seq = readdirSync(DIRS.pending).concat(readdirSync(DIRS.done))
  .map((f) => parseInt(f, 10)).filter((n) => !isNaN(n)).reduce((a, b) => Math.max(a, b), 0);
const pendingByHash = new Map<string, number>();

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function chat(req: ChatRequest): Promise<{ content: string; cached: boolean; id: number | null }> {
  const hash = hashRequest(req);
  const cachePath = join(DIRS.cache, `${hash}.json`);
  if (existsSync(cachePath)) {
    return { content: readFileSync(cachePath, 'utf8'), cached: true, id: null };
  }
  let id = pendingByHash.get(hash);
  if (id === undefined) {
    id = ++seq;
    pendingByHash.set(hash, id);
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = req.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
    writeFileSync(join(DIRS.pending, `${id}.json`), JSON.stringify({
      id, hash, model: req.model ?? '', purpose: purposeOf(String(system)),
      response_format: req.response_format?.type ?? 'text',
      system, user,
    }, null, 2));
    process.stdout.write(`[inbox] #${id} ${purposeOf(String(system))} waiting (${String(user).length} chars)\n`);
  }
  const answerPath = join(DIRS.answers, `${id}.json`);
  const started = Date.now();
  while (!existsSync(answerPath)) {
    if (Date.now() - started > 55 * 60_000) throw new Error(`no answer for #${id} after 55 minutes`);
    await sleep(500);
  }
  await sleep(150); // let the write finish
  const content = readFileSync(answerPath, 'utf8');
  writeFileSync(cachePath, content);
  try { renameSync(join(DIRS.pending, `${id}.json`), join(DIRS.done, `${id}.json`)); } catch { /* already moved */ }
  try { unlinkSync(answerPath); } catch { /* fine */ }
  pendingByHash.delete(hash);
  process.stdout.write(`[inbox] #${id} answered (${content.length} chars)\n`);
  return { content, cached: false, id };
}

function embedding(input: string): number[] {
  // 1536 floats from repeated hashing; unit-normalised so cosine maths behaves.
  const out: number[] = [];
  let seed = createHash('sha256').update(input).digest();
  while (out.length < 1536) {
    for (let i = 0; i + 1 < seed.length && out.length < 1536; i += 2) {
      out.push(((seed[i] << 8) | seed[i + 1]) / 65535 - 0.5);
    }
    seed = createHash('sha256').update(seed).digest();
  }
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}

function serve(port: number): void {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        const parsed = JSON.parse(body) as ChatRequest;
        const { content, cached } = await chat(parsed);
        const promptChars = parsed.messages.reduce((n, m) => n + String(m.content ?? '').length, 0);
        return send(200, {
          id: `chatcmpl-inbox-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: parsed.model ?? 'inbox',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: cached ? 0 : Math.ceil(promptChars / 4),
            completion_tokens: cached ? 0 : Math.ceil(content.length / 4),
            total_tokens: cached ? 0 : Math.ceil((promptChars + content.length) / 4),
          },
        });
      }
      if (req.method === 'POST' && req.url?.endsWith('/embeddings')) {
        const parsed = JSON.parse(body) as { input: string | string[]; model?: string };
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        return send(200, {
          object: 'list', model: parsed.model ?? 'text-embedding-3-small',
          data: inputs.map((text, index) => ({ object: 'embedding', index, embedding: embedding(String(text)) })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        });
      }
      send(404, { error: { message: `inbox does not serve ${req.method} ${req.url}` } });
    } catch (e) {
      send(500, { error: { message: e instanceof Error ? e.message : String(e) } });
    }
  });
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`[inbox] listening on http://0.0.0.0:${port}/v1 — prompts in ${DIRS.pending}\n`);
  });
}

function list(): void {
  const files = readdirSync(DIRS.pending).filter((f) => f.endsWith('.json')).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  if (files.length === 0) { process.stdout.write('inbox empty\n'); return; }
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(DIRS.pending, f), 'utf8')) as { id: number; purpose: string; user: string };
    process.stdout.write(`#${p.id} ${p.purpose} — ${p.user.length} chars\n`);
  }
}

const [cmd = 'serve', ...rest] = process.argv.slice(2);
if (cmd === 'serve') {
  const i = rest.indexOf('--port');
  serve(i >= 0 ? parseInt(rest[i + 1], 10) : 4141);
} else if (cmd === 'list') {
  list();
} else if (cmd === 'answer') {
  const [id, file] = rest;
  writeFileSync(join(DIRS.answers, `${id}.json`), readFileSync(file, 'utf8'));
  process.stdout.write(`answered #${id}\n`);
} else {
  process.stderr.write('usage: llm-inbox.ts serve|list|answer\n');
  process.exit(1);
}
