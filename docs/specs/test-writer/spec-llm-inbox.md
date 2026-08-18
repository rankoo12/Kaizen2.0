# Spec: The LLM inbox — Claude answers the model calls, locally, through files

**Created:** 2026-08-18
**Status:** Approved by the founder (2026-08-18: "you (claude) should be used instead of my api key")
**Owner:** test-writer / dev tooling
**Scope:** local development only. Nothing here runs in prod; prod has no `OPENAI_BASE_URL`.

---

## 0. Why

Every bench run of the Test Writer costs 130–320k tokens on the founder's OpenAI key, and the
person judging the output — Claude, in the working session — is a stronger model than the one
answering the calls. Two birds: route the local stack's model calls to Claude, through files, and
the loop is free of API spend *and* the pipeline gets answered by the judge, which separates "the
planner is weak" from "the machinery downstream is weak".

## 1. Shape

The `openai` SDK honours `OPENAI_BASE_URL`. A small local HTTP server, `scripts/llm-inbox.ts`,
implements the two endpoints Kaizen uses and nothing else:

- `POST /v1/chat/completions` → the request (model, messages, response_format) is hashed. On a
  **cache hit** (`.kaizen-llm/cache/<hash>.json`) the stored answer is returned at once. On a miss
  the prompt is written to `.kaizen-llm/pending/<seq>.json` and the request is held open until
  `.kaizen-llm/answers/<seq>.json` appears; the answer is cached and returned in OpenAI's shape,
  with `usage` estimated at 4 characters per token so billing and the token report keep working.
  A retried request with the same content maps to the same pending id — no duplicates.
- `POST /v1/embeddings` → a deterministic 1536-dim unit vector from the SHA-256 of the input.
  Meaningless semantically (dedup and cache similarity degrade to near-exact matching), never
  wrong-shaped, never billed.

Product code is untouched. Local wiring is one line in the gitignored `.env`:
`OPENAI_BASE_URL=http://host.docker.internal:4141/v1` (containers) — the api, worker and
testwriter processes pick it up on restart; the server runs on the host.

## 2. The prompt file

```json
{ "id": 17, "hash": "…", "model": "gpt-4o", "purpose": "planPageBatch",
  "response_format": "json_object",
  "system": "…", "user": "…" }
```

`purpose` is read from the span name in the system prompt's first line when present, else
`unknown`. The answer file is the assistant's content, verbatim — for `json_object` calls, the JSON
object itself:

```
.kaizen-llm/answers/17.json   ← exactly what the model would have said
```

Claude works the inbox with a directory watch: read `pending/N.json`, write `answers/N.json`.
`scripts/llm-inbox.ts list` prints what is waiting; `answer <n> <file>` is a convenience.

## 3. Limits, stated

- The SDK's per-request timeout is 10 minutes; an answer must land within that or the SDK retries
  (same hash → same pending id → still one answer). Kaizen's own step and job timeouts still apply:
  a proving run's L5 element resolution waits ~60 s.
- Answers are cached by exact normalized prompt; the same run on the same site becomes free the
  second time, a changed page invalidates only the calls that saw it.
- The cache and inbox live under `.kaizen-llm/`, gitignored: prompts contain page text.

## 4. Files

- `scripts/llm-inbox.ts` (new) — the server + `list`/`answer` subcommands
- `.gitignore` — `.kaizen-llm/`
- `benchmarks/testwriter/run.ts` — prints when the stack is answering through the inbox
