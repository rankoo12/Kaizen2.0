# Embedding tokens not counted in `step_results.tokens`

Created: 2026-04-26

## What

The `tokens` column on `step_results` only accumulates LLM completion tokens (the
final element-resolution call in `LLMElementResolver`). Embedding tokens spent
during the resolver chain — pgvector tenant search, pgvector shared search, and
any candidate re-ranking — are never charged to the step.

## Impact on UI

- `/tests` list view: per-test `totalTokens` undercounts by the embedding cost
  of every cached / pgvector-resolved step.
- `/tests/[id]`: the per-step `tokens` chip and the run summary "Tokens" cell
  show only completion usage. A step that resolves entirely via L3/L4 (pgvector)
  shows `0` even though it consumed embedding budget.

## Where embeddings happen

- `src/modules/element-resolver/cached.element-resolver.ts` — L1 db_exact
  embedding fetch is free (read), but the L3/L4 pgvector queries embed the step
  text once per call via the LLM gateway.
- `src/modules/element-resolver/llm.element-resolver.ts` — embeds the step text
  for the cache write at the end of a successful LLM resolution.

**Correction (2026-08-06)**: the gateway did NOT meter embeddings at all —
`generateEmbedding` emitted no billing event, so the spend was invisible at the
tenant level too, not merely at step level. Fixed in the Test Writer P2 work:
`generateEmbedding(text, tenantId?)` now emits an `LLM_CALL` billing event with
`purpose: 'generateEmbedding'` whenever a tenant is supplied, and the composite
resolver passes `context.tenantId`. Call sites without a tenant in scope
(healing strategies, standalone scripts) remain unbilled — pass a tenant id
there when threading one through is cheap.

Still open: the **step-level** attribution below — tenant-level spend is now
correct, but `step_results.tokens` continues to exclude embedding cost.

## Fix sketch

1. Have `LlmGateway.embed()` return `{ embedding, tokensUsed }` (it likely already
   does — check `src/modules/llm-gateway/`).
2. In every resolver layer that calls `embed()`, sum the returned `tokensUsed`
   into a local accumulator and pass it back up the chain.
3. In `src/workers/worker.ts::insertStepResult`, add the accumulator to the
   completion-token total before insert.
4. Backfill is not needed; old rows stay undercounted.

## UI follow-up

Once the column reflects total spend, no UI change required — the dashboard /
detail screens already render `step_results.tokens` and `runs.total_tokens`
unmodified.
