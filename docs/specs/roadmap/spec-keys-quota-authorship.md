# Spec: API keys, token quota, and test authorship

Created: 2026-08-04

Branch: `feat/api/keys-quota-authorship`
Parent: [spec-feature-backlog.md](./spec-feature-backlog.md) §2 — B1, B3, B13

---

## 1. Scope

Three backlog items whose UI the redesign already implies, plus one production bug found
while investigating them.

| | Item | Shape after investigation |
|---|---|---|
| B1 | API key management | Table and middleware exist; the only writer is destructive and always mints `admin` |
| B3 | Token quota + billing cycle | Budget exists and is enforced; nothing exposes it, so the meter has no denominator |
| B13 | Test author | Needs a column. No backfill is possible — see §6 |
| — | `DELETE /cases/:id` 500s in production | Found here, fixed here. See §3 |

**B2 (test drafts) is deliberately excluded.** It depends on `test_cases.status`, which
exists only on an unmerged branch — see §2.

## 2. The repo does not reproduce the running schema

Found while checking B2's premise, and it is the most important thing in this document.

`schema_migrations` in the dev database records two versions with no file in
`db/migrations/`:

```
028_test_writer      → test_cases.status, origin, generation_job_id, validation_run_id
029_site_model       → site-model tables
```

Both live on `feat/test-writer/p0-specs` (commit `b3e5ff5`), which is **not merged into
main**. So a database built from the repo — production, CI, any fresh clone — has a
different schema from every developer machine that has run that branch.

Consequences:

- **B2 cannot be built here.** The backlog calls test drafts easy because
  "`test_cases.status` already allows `draft | active | validating | rejected | archived`".
  That is true of the dev machine, not of the repo. Adding a competing `status` migration
  now would conflict with `028_test_writer` when it lands, so B2 waits for that merge.
- **Migration numbering has already collided.** `028_run_total_steps` (shipped) and
  `028_test_writer` (unmerged) share a number. Nothing broke — the runner keys on the full
  version string and sorts lexicographically — but the next migration is `030_`.
- **Anything verified locally is verified against a schema no deployment has.** §3 is one
  instance that reached production; there may be others on paths not yet exercised.

## 3. The production bug: `DELETE /cases/:caseId`

`DELETE /cases/:caseId` referenced two objects that only the unmerged migrations create:

```sql
UPDATE test_cases SET validation_run_id = NULL WHERE ...   -- column
UPDATE generation_jobs SET login_case_id = NULL WHERE ...  -- table
```

Reproduced by building a scratch database from `db/migrations/` alone — the shape
production has:

```
validation_run_id present: false
generation_jobs present: false
ERROR:  column "validation_run_id" does not exist
```

Both statements run inside `withTenantTransaction`, so the error aborts the transaction
and every case delete returns 500. It passed locally only because local machines carry the
extra migrations.

**Fix.** One catalog probe per delete, then skip the statements the schema cannot support:

```sql
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'test_cases'
             AND column_name = 'validation_run_id') AS has_validation_col,
  to_regclass('public.generation_jobs') IS NOT NULL AS has_generation_jobs
```

Chosen over a `try/catch` because a failed statement in Postgres poisons the surrounding
transaction — recovering would need a `SAVEPOINT` per statement, which is more machinery
for the same result. When `028_test_writer` merges, both flags are permanently true and
this collapses back to unconditional statements.

## 4. B1 — API keys

**Reality, corrected.** The backlog says the only route "rotates the *legacy* single
`tenants.api_key_hash`". It does not: `TenantService.rotateApiKey`
([tenant.service.ts:202](../../../src/modules/identity/tenant.service.ts#L202)) writes a
real `api_keys` row. The actual problems are different and worse:

- It **deletes every existing key** for the tenant first. Rotating to give one CI pipeline
  a fresh key silently breaks every other pipeline using a different one.
- It always mints **`admin`** scope. The table has a `key_scope` enum
  (`read_only | execute | admin`) and `requireScope` enforces it, but nothing can create
  anything except the most privileged option.
- No description, no expiry, no per-key revoke — all columns that already exist.

**Contract.**

```ts
type ApiKeySummary = {
  id: string;
  keyPrefix: string;                 // 'kzn_live_' + 9 chars — enough to recognise, useless to use
  scope: 'read_only' | 'execute' | 'admin';
  description: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

GET    /tenants/:tenantId/keys              → { keys: ApiKeySummary[] }
POST   /tenants/:tenantId/keys              → 201 { key: ApiKeySummary, rawKey: string }
DELETE /tenants/:tenantId/keys/:keyId       → 204
```

`rawKey` is returned **once, on creation only**. Only the SHA-256 hash is stored
(`hashKey`, already used by `requireApiKey`), so it cannot be recovered afterwards — the UI
must say so before the sheet is dismissed.

**Authorization.** `requireAuth` + `requireRole('admin')` for all three, matching
`/tenants/:id/usage`. One exception: minting an **`admin`-scoped** key requires `owner`,
because such a key can do anything the admin API can, including creating more keys. A
tenant admin can still mint `read_only` and `execute` keys.

The legacy `POST /tenants/:tenantId/api-key` stays reachable so any existing caller keeps
working, but the UI no longer offers it — the rotate button and its confirm sheet are gone,
because "rotate" meant "revoke every key in this workspace".

### 4.1 Found while writing the CI snippet: keys cannot run a saved test

The Usage screen documented `POST /runs` with an `X-API-Key` header and a `{"caseId"}`
body. All three parts were wrong, and following it returns 401 then 400:

- `requireApiKey` reads `Authorization: Bearer`, never `X-API-Key`.
- `POST /runs` takes `{ steps, baseUrl }`, not `caseId`.
- Running a **saved** test is `POST /cases/:caseId/run` — and that route sits behind
  `requireAuth`, which is **JWT only**. An API key gets 401 there.

So today an API key can run ad-hoc steps but cannot trigger a test you already have,
which is the obvious thing to want a key for. The snippet now shows only what works and
says so plainly.

**Not fixed here, deliberately.** Switching that route to `requireTenant` would accept
both auth kinds in one word, but `requireTenant` carries no scope check — a `read_only`
key would gain the ability to start runs, which `POST /runs` explicitly prevents with
`requireScope('execute')`. Doing it properly means a guard that enforces scope only on the
key path, which is a real change and belongs with B11 (CI integration) rather than
smuggled into a plumbing branch.

## 5. B3 — token quota + billing cycle

`tenants.llm_budget_tokens_monthly` exists and **is enforced** — `POST /cases/:id/run`
returns 402 `INSUFFICIENT_TOKENS` (budget 0) or `TOKEN_LIMIT_REACHED` (used ≥ budget). No
endpoint exposes it, so the Usage screen shows spend with no denominator.

`TenantService.getUsage` already sums `billing_events` where `event_type = 'LLM_CALL'`
from the first of the calendar month. **The cycle is a calendar month** — stated here
because the backlog left it open, and because `usageThisMonth` (the enforcement path) uses
the same boundary. Enforcement and display must not disagree.

Sourcing note: this counts **billed** tokens, not `step_results.tokens_used`. Those two now
agree — A10 stopped prompt-cache replays reporting tokens for a call that never happened —
but where they could ever diverge, a quota must be enforced against what was billed.

**Contract.** `GET /tenants/:tenantId/usage` gains:

```ts
{
  // …existing runsThisMonth, llmTokensThisMonth, memberCount…
  budgetTokensMonthly: number;   // 0 means "no allowance"; runs are rejected at submit
  cycleStart: string;            // ISO, first instant of the calendar month
  cycleEnd: string;              // ISO, first instant of the next month — when it resets
}
```

A budget of `0` is a real state (migration 019 made it the default for new tenants), so the
UI must distinguish "no allowance configured" from "allowance exhausted". They produce
different 402 codes and need different copy.

## 6. B13 — test author

No `created_by` on `test_cases`. Memberships already exist, so this is a nullable column.

### Migration `030_test_case_created_by.sql`

```sql
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
```

**No backfill.** Nothing records who created a historical case — there is no audit trail to
reconstruct from, and attributing them to the workspace owner would be a guess presented as
fact. Existing cases show no author; only cases created after this ships have one. Left
nullable for the same reason, plus API-key-created cases have no user at all.

`ON DELETE` is left as the default `NO ACTION`: a deleted user should not silently orphan
authorship, and `users` are soft-deleted (`deleted_at`) rather than removed.

**Contract.** Case list and detail gain:

```ts
createdBy: { id: string; displayName: string | null; email: string } | null
```

Null renders as nothing at all, not "Unknown" — see §7.

## 7. Verification

Per `feedback_verify_before_prod`: unit tests where there is logic, plus a real end-to-end
pass against the live stack.

| Item | Proof required |
|---|---|
| §3 delete | A case deletes with 204 on a database built from `db/migrations/` alone, **and** on the drifted local schema. Both paths, not one. |
| B1 | A key created in the UI triggers a run via `POST /runs` with its raw value; revoking it makes the same call 401; a `read_only` key is refused by `requireScope('execute')`; creating a second key does not invalidate the first. |
| B3 | The meter's denominator matches `tenants.llm_budget_tokens_monthly`, and the reset date matches the boundary enforcement actually uses. A tenant at budget 0 reads differently from one at its limit. |
| B13 | A case created now shows its author; one created before the migration shows no author rather than a fabricated one. |

`npm run audit:contrast` stays at zero unreadable. CI (`.github/workflows/ci.yml`) must be
green.

## 8. Out of scope

- **B2 test drafts** — blocked on `028_test_writer` merging (§2).
- Retiring `POST /tenants/:tenantId/api-key` — deprecated in favour of the new routes, but
  left working so existing callers do not break.
- `billing_events.run_id`, a distinct `resolution_source` for prompt-cache replays, and
  `fail_count_window` decay — carried over from the previous branch, still open.
- Reconciling the repo with the running schema. §2 is a finding, not a fix; it belongs to
  whoever merges the test-writer branch.
