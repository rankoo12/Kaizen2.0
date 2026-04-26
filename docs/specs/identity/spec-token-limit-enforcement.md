# Spec: Tenant Token Limit Enforcement

Created: 2026-04-27
Updated: 2026-04-27

## 1. Context

Each tenant has a column `tenants.llm_budget_tokens_monthly` (BIGINT) that
sets a monthly cap on LLM token spend. Today the enforcement at
[test-cases.ts:547-556](src/api/routes/test-cases.ts) only checks
`llm_budget_tokens_monthly > 0` — i.e. "tenant has any allowance at all" —
but **never compares the budget against actual usage**. A tenant configured
with a 5,000-token budget can still queue unlimited runs; the check is a
no-op above zero.

Reproduction: set `tenants.llm_budget_tokens_monthly = 5000` for a test
tenant, then trigger runs. Runs continue to be enqueued and consume tokens
indefinitely.

## 2. Goal

Hard-cap token spend at the **enqueue** boundary. When a tenant has consumed
≥ `llm_budget_tokens_monthly` for the current calendar month, the
`POST /cases/:caseId/run` route returns `402 Payment Required` with a
human-readable message **before** any compile / queue work happens.

## 3. Non-goals

- No mid-run termination. Once a run is enqueued it runs to completion
  regardless of how much it pushes the tenant over the cap. (Per-LLM-call
  enforcement is a separate, more invasive concern — out of scope here.)
- No soft warning surface in the UI. The 402 toast already lands in the
  frontend's existing 402 handler.
- No change to the budget shape. Single integer column,
  rolling-calendar-month window. Per-user / per-suite quotas are out of
  scope.
- No change to embedding-token tracking — that gap is documented separately
  in [`docs/known-issues/embedding-tokens-not-tracked.md`](../../known-issues/embedding-tokens-not-tracked.md).

## 4. What "month" means

Calendar month, tenant-local timezone-naive: `usage_window_start =
date_trunc('month', now())` and `usage_window_end = now()`. The
billing_events table is queried for that window, summed, and compared
against the budget.

If the user wants per-day or per-rolling-30 windows later, this spec
doesn't preclude it — just change the `date_trunc` clause.

## 5. Implementation

### 5.1 Schema

No migration required. The relevant columns already exist:

- `tenants.llm_budget_tokens_monthly BIGINT`
- `billing_events (tenant_id, event_type, quantity, created_at)` — written
  by [src/modules/billing-meter/postgres.billing-meter.ts](src/modules/billing-meter/postgres.billing-meter.ts)
  on every LLM call. `quantity` is tokens.

### 5.2 New helper: `usageThisMonth(tenantId)`

New module: `src/modules/billing-meter/usage.ts`

```ts
import { getPool } from '@/db/pool';

export async function usageThisMonth(tenantId: string): Promise<number> {
  const { rows } = await getPool().query<{ total: string }>(
    `SELECT COALESCE(SUM(quantity), 0)::text AS total
     FROM billing_events
     WHERE tenant_id = $1
       AND event_type = 'LLM_CALL'
       AND created_at >= date_trunc('month', now())`,
    [tenantId],
  );
  return Number(rows[0]?.total ?? 0);
}
```

Returns the running total of LLM tokens spent by `tenantId` since the start
of the current calendar month. Zero if no rows.

### 5.3 Enqueue route change

In [src/api/routes/test-cases.ts](src/api/routes/test-cases.ts), replace the
existing budget check (lines 547–556) with:

```ts
const { rows: budgetRows } = await getPool().query<{ llm_budget_tokens_monthly: string }>(
  `SELECT llm_budget_tokens_monthly FROM tenants WHERE id = $1`,
  [tenantId],
);
const budget = Number(budgetRows[0]?.llm_budget_tokens_monthly ?? 0);
if (budget <= 0) {
  return reply.status(402).send({
    error: 'INSUFFICIENT_TOKENS',
    message: 'This account has no LLM tokens allocated. Contact the workspace owner to enable runs.',
  });
}

const used = await usageThisMonth(tenantId);
if (used >= budget) {
  return reply.status(402).send({
    error: 'TOKEN_LIMIT_REACHED',
    message: `Token limit reached (${budget.toLocaleString()}). Used ${used.toLocaleString()} this month.`,
    used,
    budget,
  });
}
```

The message format matches the user's preference: `Token limit reached (5,000). Used 5,212 this month.`

### 5.4 Frontend

Frontend already handles 402 at:
- `tests-dashboard.tsx::runCase` — surfaces `body.message` as a danger toast
- `test-detail-screen.tsx::startRun` — same
- `new-test-screen.tsx::handleSaveAndRun` — same; the test still saves, run
  doesn't enqueue

No frontend code changes required. The new message string flows through
unchanged.

## 6. Test plan

Unit tests in `src/modules/billing-meter/__tests__/usage.test.ts`:

1. Returns 0 when no `billing_events` rows exist for the tenant.
2. Returns sum of `quantity` for rows in the current month.
3. Excludes rows from previous calendar months.
4. Excludes rows where `event_type != 'LLM_CALL'`.
5. Tenant scoping — sums only rows matching the given `tenant_id`.

Integration test in `src/api/routes/__tests__/test-cases.test.ts` (or wherever
existing run-enqueue tests live):

1. Tenant with `llm_budget_tokens_monthly = 5000` and 4,999 used → 202 enqueued.
2. Tenant with `llm_budget_tokens_monthly = 5000` and 5,000 used → 402 with
   `error: 'TOKEN_LIMIT_REACHED'` and the expected message format.
3. Tenant with `llm_budget_tokens_monthly = 5000` and 5,200 used (already
   over) → 402 with same shape.
4. Tenant with `llm_budget_tokens_monthly = 0` → 402 with the existing
   `INSUFFICIENT_TOKENS` error (preserved behaviour).

Manual verification:
- `UPDATE tenants SET llm_budget_tokens_monthly = 100 WHERE email = 'test@test.com';`
- Trigger a run that consumes >100 tokens.
- Trigger a second run via the dashboard `Run` action — toast appears with the
  exact format `Token limit reached (100). Used N this month.`

## 7. Risks

- **Race window.** Two runs queued simultaneously near the cap can both pass
  the check (each sees `used < budget`) and both enqueue. After they
  complete the tenant is over budget by ~one run's worth of tokens. Acceptable
  — this is a soft fence at best for hard quotas, and we're not advertising
  to-the-token precision.
- **Embedding token undercount** (see known-issues note). Real spend is
  higher than the `LLM_CALL` event total; tenants effectively get a small
  amount of free embedding budget. Acceptable until the gap is closed.
- **Long-running over-cap runs.** A single run can push usage way over the
  cap before completing. Per-call mid-run enforcement is the future-state
  fix; outside this spec.
