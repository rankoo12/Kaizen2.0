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

The gateway already meters those calls via `PostgresBillingMeter`, so the spend
exists at the **tenant** level. It's just never threaded down to the
**step-result** row.

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
