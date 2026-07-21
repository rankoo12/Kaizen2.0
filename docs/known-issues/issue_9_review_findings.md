# Issue 9 — Full-Project Review Findings (Security, Data Flow, UX, Redundancy)

Created: 2026-07-21
Status: Catalogued — not yet remediated. Tracking doc for a whole-repo review.

This is the consolidated output of a full read-through of the codebase. Each item
cites `file:line` and a one-line fix direction. Severity: **Critical / High / Medium / Low**.
Items already tracked in other `known-issues/` files are not repeated here.

---

## 1. Security

### 1.1 Critical

- **`/runs` route file is unauthenticated (cross-tenant IDOR, read + write).**
  Only `GET /runs` has a `requireAuth` preHandler ([src/api/routes/runs.ts:80](../../src/api/routes/runs.ts)). Every other route trusts an unguessable-but-not-secret UUID (or a body-supplied `tenantId`) with no auth and no `tenant_id` filter:
  - `POST /runs` ([runs.ts:39](../../src/api/routes/runs.ts)) — takes `tenantId` from the body ("Phase 1: no auth", line 34); enqueues arbitrary-URL browser jobs + LLM compilation billed to any tenant, bypassing the token-budget gate.
  - `GET /runs/:id`, `GET /runs/:id/report` — leak any tenant's run, step results, selectors, screenshot keys, captured values.
  - `PATCH /runs/:runId/steps/:stepId/verdict` and `.../candidate` — let an attacker delete or **poison** any tenant's `selector_cache` (incl. `pinned_at` rows) and shared-pool rows.
  - `POST /runs/:id/cancel`, `GET /media`.
  - **Fix:** add `requireAuth` + `tenant_id = request.tenantId` to every query in this file; remove body-supplied `tenantId` from `POST /runs`.

- **`GET /media` — unauthenticated arbitrary file read + cross-tenant screenshot read.**
  [runs.ts:666](../../src/api/routes/runs.ts) has no auth; `key` flows straight to `ScreenshotService.download` ([src/modules/media/screenshot.service.ts:79-106](../../src/modules/media/screenshot.service.ts)). In local-fallback mode a key like `/etc/passwd` (or `../…`) is passed to `fs.readFileSync`. In GCS mode the `{tenantId}/…` key has no tenant check.
  - **Fix:** require auth; verify the screenshot's run belongs to the caller's tenant; reject absolute / `..` keys.

### 1.2 High

- **RLS is enabled but not enforced.** Policies exist on all tenant tables ([db/migrations/001_initial_schema.sql:272-315](../../db/migrations/001_initial_schema.sql)) using `current_setting('app.current_tenant_id')`, but there is **no `FORCE ROW LEVEL SECURITY`**, and the app/worker connect as the `kaizen` role (compose superuser + table owner), which bypasses RLS. Almost all worker + `runs.ts` queries use the raw pool without `withTenantTransaction`, so the GUC is never set anyway. The schema comment ("a bug in application code cannot leak cross-tenant data") is currently false.
  - **Fix:** add a dedicated non-owner app role, `ALTER TABLE … FORCE ROW LEVEL SECURITY`, and route tenant-scoped queries through `withTenantTransaction`.

- **`updateOutcomeWindow` clobbers confidence across tenants + shared pool.**
  [src/modules/element-resolver/llm.element-resolver.ts:572-594](../../src/modules/element-resolver/llm.element-resolver.ts) — `SELECT … LIMIT 1` (no `tenant_id`, no `is_shared`, no `ORDER BY`) then `UPDATE … WHERE content_hash = $4 AND domain = $5` rewrites every tenant's row and the shared row for that target+domain. Also a read-modify-write race.
  - **Fix:** scope both queries by `tenant_id` (and `is_shared`); do it in one transaction.

- **Production `Dockerfile.web` runs the dev server → session cookies lose `Secure`.**
  [packages/web/Dockerfile.web:11](../../packages/web/Dockerfile.web) `CMD ["npm","run","dev"]`, no build step → `NODE_ENV` ≠ production → [packages/web/src/lib/cookies.ts:8,16](../../packages/web/src/lib/cookies.ts) `secure: isProduction` is `false`. JWT access/refresh cookies transmit over plain HTTP.
  - **Fix:** multi-stage build → `npm run build` + `npm run start`; set `NODE_ENV=production`.

- **Open redirect on login.** [packages/web/src/components/organisms/login-form.tsx:28-29](../../packages/web/src/components/organisms/login-form.tsx) — `searchParams.get('next')` is passed to `router.push` unvalidated. `/login?next=//evil.com` navigates off-site post-auth.
  - **Fix:** accept only values matching `^/(?!/)`.

- **No rate limiting / brute-force protection** on `/auth/login`, `/auth/token`, `/auth/refresh`, `/auth/password-reset/confirm`, `/platform/auth/login`. No `@fastify/rate-limit` or `@fastify/helmet` registered ([src/api/server.ts](../../src/api/server.ts)).
  - **Fix:** register `@fastify/rate-limit` (strictest on auth) and `@fastify/helmet`.

- **CORS defaults to `*`.** [src/api/server.ts:72](../../src/api/server.ts) `origin: process.env.CORS_ORIGIN ?? '*'` — wide open if the env var is unset in prod.
  - **Fix:** require an explicit allow-list in production; no `*` fallback.

### 1.3 Medium / Low

- **Token confusion risk.** `POST /auth/token` API-key branch signs `{ tenantId, scope }` with no `sub`/`role`/`type` on the shared RS256 keypair ([src/api/routes/auth.ts:130-133](../../src/api/routes/auth.ts)); user vs platform-admin tokens are distinguished only by a `type` string on one keypair. **Fix:** add a mandatory `type` (and ideally `aud`) claim checked in every guard.
- **PII/secrets in logs & `run_events`.** Post-interpolation step `value` is persisted to `run_events` ([src/workers/worker.ts:330-333](../../src/workers/worker.ts)) and shown in the report — a `type {{password}}` step writes the concrete password. `captured_value` ([worker.ts:502,530](../../src/workers/worker.ts)) and the `resolver.all_selectors_invalidated` diagnostic ([llm.element-resolver.ts:197-226](../../src/modules/element-resolver/llm.element-resolver.ts)) also dump page data. **Fix:** redact known-sensitive values before logging/persisting.
- **Email reset/verify/invite tokens logged in plaintext.** [src/modules/identity/log-email.service.ts:12-41](../../src/modules/identity/log-email.service.ts) logs the raw token in the link (a v1 stub, but the raw token is the sharp edge). **Fix:** never log raw tokens.
- **Cross-tenant archetype learning from untrusted page text.** LLM-picked accessible names promote into the global, tenant-agnostic `element_archetypes` via `learn()` ([worker.ts:521-528](../../src/workers/worker.ts) → [src/modules/element-resolver/db.archetype-resolver.ts:128-134](../../src/modules/element-resolver/db.archetype-resolver.ts)). Role/action/overlap gates mitigate, but it is a cross-tenant write from page-controlled content. **Fix:** consider domain scoping / a promotion threshold (see issue_8).
- **Verify tokens never expire.** `verifyExpires` is computed then discarded ([src/modules/identity/user.service.ts:97,132](../../src/modules/identity/user.service.ts)); `verifyEmail` never checks expiry. **Fix:** persist and enforce the expiry.
- **Dockerfiles / dockerignore.** `Dockerfile.api` (`npm install`, `COPY . .`, references `dist/` that is never built) and root `.dockerignore` do not exclude `secrets/` — if `Dockerfile.api` is ever used, `secrets/gcs-key.json` bakes into the image. `packages/web/.dockerignore` omits `.env*`, so `.env.local` bakes into the web image layer. `Dockerfile.worker` production runs as root. **Fix:** add `secrets/` + `.env*` to all `.dockerignore`s; `npm ci`; non-root `USER`.
- **`sync-ai.sh` secret guard is thin.** `.repomixignore` does not list `secrets/` (relies solely on repomix honoring `.gitignore`); the scanner misses `postgres://user:pass@…` strings, the `kzn_live_<32hex>` key format, and base64 blobs (`gcs-key.b64`), and has a `KAIZEN_AI_SKIP_SCAN=1` bypass. **Fix:** add `secrets/` + `*.b64` to `.repomixignore`; extend scanner patterns.
- **`export-step-results.ts`** dumps latest 200 `step_results` across all tenants (incl. `captured_value`) to `./step_results.json` at repo root, which is not gitignored. **Fix:** add `--tenant` filter; gitignore the output.
- **`truncate-caches.ts`** is far more destructive than its header (wipes shared pool, permanent verdict blocks, seeded `compiled_ast_cache`, and `healing_events` via CASCADE) with no dry-run gate, against whatever `DATABASE_URL` points at. **Fix:** add an `--apply` confirmation; narrow the CASCADE.

---

## 2. Data-flow correctness (engine / worker)

### 2.1 High

- **`wait` steps can never pass.** Worker gives `wait` an empty selector set ([worker.ts:444](../../src/workers/worker.ts)); the engine fails any non-navigate/press_key action with zero selectors ([src/modules/execution-engine/playwright.execution-engine.ts:55-62](../../src/modules/execution-engine/playwright.execution-engine.ts)) before the `wait` timeout branch is reachable. Stop-on-fail then kills the run. **Fix:** handle `wait` before the no-selectors guard.
- **Browser/context leak on setup failure.** `chromium.launch/newContext/newPage/goto` run before the `try` whose `finally` closes them ([worker.ts:163-200](../../src/workers/worker.ts)). A goto timeout / bad `baseUrl` leaks headless Chromium and never clears the cancel key. **Fix:** move launch inside the `try`.
- **Worker crash leaves runs stuck in `running`.** Queue `attempts: 1` ([src/queue/index.ts:49](../../src/queue/index.ts)); a SIGKILL mid-run skips the catch that marks `failed`. No reconciliation job exists. **Fix:** add a stale-run reaper (e.g. `running` + `started_at` older than `MAX_JOB_TIMEOUT_MS` → `failed`).
- **Heal result never repairs the cache.** `ResolveAndRetryStrategy` updates embeddings keyed by `content_hash` while rows are keyed by `targetHash`, and never updates the `selectors` column ([src/modules/healing-engine/strategies/resolve-and-retry.strategy.ts:78,112-119](../../src/modules/healing-engine/strategies/resolve-and-retry.strategy.ts)). The broken selector stays cached; every future run re-fails and re-heals. **Fix:** key by `targetHash`; write the healed selector back.

### 2.2 Medium

- **Exception escaping `executeStep` drops the whole audit trail** — no failed row, no skipped-tail rows, RunLogger buffer never flushed ([worker.ts:207,446](../../src/workers/worker.ts)). **Fix:** wrap the step body; flush + persist a failed row in a catch.
- **L1 Redis cache defeats itself** — every cacheable step deletes the key it just wrote via `invalidateRedisCache` on a full-keyspace `SCAN` ([llm.element-resolver.ts:596-603](../../src/modules/element-resolver/llm.element-resolver.ts), [src/modules/element-resolver/redis-cache.utils.ts:17-22](../../src/modules/element-resolver/redis-cache.utils.ts)). **Fix:** invalidate by exact key, not SCAN; don't invalidate on the write path.
- **Token misreporting on prompt-dedup hits** — dedup-cache hits keep the original token counts and sum them into `step_results.tokens_used` / the report, though no tokens were spent ([src/modules/llm-gateway/openai.gateway.ts:189-192](../../src/modules/llm-gateway/openai.gateway.ts), [llm.element-resolver.ts:333](../../src/modules/element-resolver/llm.element-resolver.ts)). Provenance also mislabeled (`fromCache:false, resolutionSource:'llm'`). **Fix:** zero out tokens on cache hits; label the source.
- **Unvalidated `compileStep` output → permanent cache poison** — `JSON.parse(...) as StepAST` with no enum/shape check ([openai.gateway.ts:151](../../src/modules/llm-gateway/openai.gateway.ts)); a bad `action` persists to `compiled_ast_cache` and throws `Unsupported action` on every future run. **Fix:** validate against the action enum before persisting.
- **Interpolated steps cache under the token-form hash** — `interpolateStep` keeps `contentHash`/`targetHash` unchanged ([src/workers/run-context.ts:40-47](../../src/workers/run-context.ts)), so a `{{var}}`-bearing target can serve last run's element from L1/L2. **Fix:** re-hash after interpolation, or bypass cache for interpolated targets.
- **Budget/quota holes** — `isOverBudget` is a stub returning `false` ([src/modules/billing-meter/postgres.billing-meter.ts:56-59](../../src/modules/billing-meter/postgres.billing-meter.ts)) though the gateway interface claims it is checked before every call; the case-run budget check is read-then-enqueue (TOCTOU); `generateEmbedding` emits no billing event; `TEST_RUN_STARTED` only fires on the legacy route. **Fix:** implement `isOverBudget` and call it; meter embeddings.
- **Shared-pool quality gate is toothless** — `contribute()` is called with a hardcoded `confidenceScore: 1.0` ([llm.element-resolver.ts:516](../../src/modules/element-resolver/llm.element-resolver.ts)), so the `QUALITY_THRESHOLD` 0.8 gate never filters; concurrent workers also create duplicate shared rows (NULL `tenant_id` defeats the UNIQUE). **Fix:** pass the real confidence; add a partial unique index for shared rows.

### 2.3 Low

- Cancel lost for runs queued > 5 min (cancel-key TTL 300s, [runs.ts:648](../../src/api/routes/runs.ts)); `scroll` false-passes on a non-matching selector ([playwright.execution-engine.ts:343-347](../../src/modules/execution-engine/playwright.execution-engine.ts)); `OpenAI({ apiKey: … ?? 'sk-mock-key' })` defers a missing key to per-call errors ([openai.gateway.ts:89](../../src/modules/llm-gateway/openai.gateway.ts)); `ElementSimilarityStrategy` embeds every AX leaf unbounded, no domain filter, and its embedding string omits the `@ /path` suffix so it likely near-never fires.

---

## 3. UX flow (frontend)

- **Run-history rail is a dead control** — `onSelect` receives the run id but discards it ([packages/web/src/components/organisms/test-detail-screen.tsx:227](../../packages/web/src/components/organisms/test-detail-screen.tsx)); clicking a historical run does nothing. **Fix:** store the id into `activeRunId`.
- **"No suites yet" flashes on every cold load** — `useSuites` treats a not-yet-hydrated user as "no data" and never consumes auth `isLoading` ([packages/web/src/hooks/use-suites.ts:24-28](../../packages/web/src/hooks/use-suites.ts)). **Fix:** gate on auth hydration.
- **Save & run can create duplicate tests** — a failed enqueue after a successful `createCase` leaves the filled form, so re-submitting creates a second case ([new-test-screen.tsx:105-135](../../packages/web/src/components/organisms/new-test-screen.tsx)). **Fix:** navigate to the created case even when the run enqueue fails.
- **Polling never gives up** — `use-run-poller` and `use-run-detail` treat a post-refresh 401 as transient and retry forever; the Run button stays disabled with no error surfaced ([packages/web/src/hooks/use-run-poller.ts:41](../../packages/web/src/hooks/use-run-poller.ts)). **Fix:** stop + surface an error after N consecutive failures / on 401.
- **Dashboard data is stale after a run** — `handleRunComplete` patches only a status override; duration/tokens/etc. keep pre-run values (`useAllCases` exposes no `refetch`, [packages/web/src/hooks/use-all-cases.ts](../../packages/web/src/hooks/use-all-cases.ts)). **Fix:** expose and call `refetch`.
- **Opening a test is double-click only, mouse only** — grid cells / list rows are click-handling `div`s with no keyboard activation, no "open" affordance ([tests-dashboard.tsx:531,720](../../packages/web/src/components/organisms/tests-dashboard.tsx)). **Fix:** make rows focusable buttons/links with Enter/Space.
- **Run-report error state is a dead end** (no back/retry, [run-report.tsx:22-31](../../packages/web/src/components/organisms/run-report.tsx)); **toast timers collide** (uncleared 3s `setTimeout`, copy-pasted in three screens); **many fake affordances** (Enter-to-add-step hint with no handler, `/`-search kbd hint with no handler, "Run suite"/branch/collapse buttons with no `onClick`, "Forgot Password?", Google/Facebook auth). **Fix:** wire or mark `<Wip/>`.
- **Race bugs in data hooks** — `use-run-detail` and `use-case-detail` have no request-cancellation, so out-of-order responses commit stale data for a previous id; `use-run-detail`'s shared `inFlightRef` can drop the first fetch for a new run and never reschedule ([use-run-detail.ts:27-29](../../packages/web/src/hooks/use-run-detail.ts), [use-case-detail.ts:11-23](../../packages/web/src/hooks/use-case-detail.ts)). **Fix:** add a `cancelled` flag per effect (as `use-run-report` already does).

---

## 4. Redundant / dead code (verified no-usage)

- **`.old/` trees are fully unreferenced** — `organisms/.old/{tests-panel,new-test-panel,test-overview-panel}.tsx`, `atoms/.old/logo.tsx`, and their only-consumers `hooks/use-cases.ts`, `molecules/{step-item,suite-selector}.tsx`, `atoms/textarea.tsx`. Zero importers outside `.old/`. Safe to delete.
- **Zero-importer components** — `molecules/nav-bar.tsx`, `atoms/badge.tsx`, `resolutionSourceLabel` in `lib/resolution-source.ts`, the `StatusDot` re-export in `side-rail.tsx`.
- **Backend dead surface** — `selector_cache_aliases` table (never queried; the "L2 alias" cache was never built); `IBillingMeter.getCurrentUsage`/`isOverBudget` stubs; `IObservability.histogram`; `confidence.ts` `classifyConfidence`/`ConfidenceState`; `CandidateNode.xpath` (always `''`) / `centerPoint` (never read); `SelectorSet.fromCache`/`cacheSource`; `LLMResolutionResult.templateVersion`; `run-logger.ts:64-65` dead `cols`.
- **Duplicated logic to consolidate** — 5× frontend `API_URL` constant + duplicated `tryRefresh`/cookie-clear (proxy & auth routes); run-enqueue 402 handling copy-pasted 3× across screens; 4 word-overlap scorers and 2 card-title heuristics in the resolver; `normalise()`+`hash()` in 4 places (compiler + 3 scripts, diverging); `generateSlug`/`hashToken`/`hashKey` duplicated across identity services; pg-Client boilerplate in 7 scripts; verdict/candidate cache-purge block duplicated in `runs.ts`; two role-filter implementations run on the same candidates.

---

## 5. Migrations / build / repo hygiene

- **Duplicate migration number `021`** — `021_archetype_failures_expires_at.sql` and `021_username_input_archetype.sql`. `migrate.ts` keys on the full filename, so both apply, but fresh-DB order (`a` < `u`) differs from historical order (the `_expires_at` file was added after `022`). Order-independent today, but the "number = order" invariant is broken and nothing detects it. `validate-migrations.ts` is a stale one-off hardcoded to 023/024. **Fix:** rename one (both are idempotent); add a duplicate-prefix assertion to `migrate.ts`.
- **Inner `BEGIN/COMMIT` in 007/011/012** commits the runner's outer transaction early, voiding rollback-on-error for the `schema_migrations` insert. **Fix:** remove inner transaction statements.
- **Archetype content has two sources of truth** — migrations 016/017/018/021_username mutate `element_archetypes`, but the 100+ canonical rows live only in `db/seeds/element_archetypes.sql` (run manually). A fresh `db:migrate` yields ~2 archetypes; re-running the seed (contrary to its "DO NOTHING" header, it's `DO UPDATE`) wipes auto-learned patterns. **Fix:** pick one source; make the seed additive.
- **Broken lint script** — `package.json` `"lint": "eslint src --ext .ts"`; `--ext` was removed in ESLint 9 (flat config), so it errors. **Fix:** `"lint": "eslint src"`.
- **Tracked junk files** — `billing_test_output.txt`, `jest_output.txt`, `result.txt` (UTF-16 dumps of failed jest runs) and `kaizen-global-brain-seeding-spec.md` (a real spec at repo root instead of `docs/specs/`). **Fix:** delete the dumps + add `*_output.txt` to `.gitignore`; move the spec.
- **~7 unused prod dependencies** — `@pinecone-database/pinecone`, `stripe`, `@anthropic-ai/sdk`, `@aws-sdk/client-s3`, all `@opentelemetry/*`, and `railway` (an unrelated package to the Railway CLI — supply-chain smell). No imports anywhere. **Fix:** remove.
- **`.env.example` describes a different stack than the code** — documents Pinecone (code uses pgvector), S3 (code uses GCS), `JWT_SECRET`/HMAC (code uses `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` RS256), and Stripe (billing is Postgres-only); omits `GCS_BUCKET`/`GCS_KEY_FILE`/`GCS_KEY_B64`, `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`, `CORS_ORIGIN`, `KAIZEN_API_URL`. An operator following it cannot configure the app. **Fix:** rewrite to match the implemented stack.
