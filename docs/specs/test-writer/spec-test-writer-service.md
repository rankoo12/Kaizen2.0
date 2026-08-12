# Spec — Test Writer Service (Kaizen as a QA Engineer: umbrella)

Created: 2026-07-29
Updated: 2026-08-06 — P2 refinement: structured-intent re-decision (§1), plan-approval
checkpoint (§4/§5/§8), Init Brief (§12), security & data posture (§13). P1 (RECON) is
implemented and live-validated.
Branch: `feat/test-writer/generation-pipeline`
Status: Design agreed with product owner; P1 built, P2 not started.

> Umbrella spec for the Test Writer service. Companions (read in this order):
> 1. `spec-recon-crawler.md` — Phase 1 RECON: the smart crawler + safety classifier.
> 2. `spec-comprehension-knowledge-model.md` — Phase 2 COMPREHEND: Site Knowledge + App Brief.
> 3. `spec-generation-pipeline.md` — Phases 3–5 PLAN / WRITE / VALIDATE.
> 4. `../tests-ux/spec-draft-review-ux.md` — draft lifecycle + review UI.

## 1. Motivation

Kaizen today is a self-healing test *executor*. To sell Kaizen as a **full QA
engineer**, it must also *create* tests the way a QA engineer does. The core
product decision: **recon-first knowledge acquisition**. On first encounter
with a domain, Kaizen explores it (crawl), comprehends it (knowledge synthesis),
plans what to test, writes tests grounded in the real UI, and validates every
test by actually running it — before proposing anything to the user.

| Human QA engineer | Kaizen phase | Spec |
|---|---|---|
| Explores the app | 1. RECON | spec-recon-crawler.md |
| Forms an understanding | 2. COMPREHEND | spec-comprehension-knowledge-model.md |
| Identifies user journeys | 2. (App Brief output) | spec-comprehension-knowledge-model.md |
| Writes a test plan | 3. PLAN | spec-generation-pipeline.md |
| Writes tests grounded in the UI | 4. WRITE | spec-generation-pipeline.md |
| Verifies they work | 5. VALIDATE | spec-generation-pipeline.md |
| Maintains as the app changes | 6. MAINTAIN | future spec (P5) |

The load-bearing insight: a Kaizen test is `{ name, baseUrl, steps: string[] }`
— natural-language sentences ARE the interface. The Test Writer only emits
English step strings; compilation, resolution, execution, healing, persistence
and review all reuse the existing machinery unchanged.

> **Product re-decision (2026-08-06, approved)**: NL remains the USER-facing
> interface — humans review and edit English, and edited steps go through the
> normal compiler. But internally the generator no longer emits English: it
> emits **structured intents** referencing crawled `page_elements` rows, and a
> deterministic renderer produces both the NL sentence and the StepAST
> (generation-pipeline spec §3). Rationale: kills hallucinated elements
> (schema error) and negative-polarity gambles structurally, and removes the
> LLM re-compile of generated steps (~half the job's token cost). Constructed
> ASTs are stored on `test_steps.compiled_ast` — never in the global
> `compiled_ast_cache` (isolation invariant §11 holds).

## 2. Product decisions (locked)

1. **Recon-first, always.** The first suggest/analyze on a domain triggers
   recon (bounded crawl + comprehension). Generation always reads from stored
   Site Knowledge; a single-page suggest is a scoped query against it.
2. **Interactive exploration from day one**, gated by the interaction safety
   classifier (spec-recon-crawler.md §4). The crawler must "understand where it
   is and what it's touching" and never perform a mutating action.
3. **Consent-tiered auth scope.** Default scope crawls public/unauthenticated
   pages only. Authenticated exploration requires BOTH a login recipe AND an
   explicit consent flag, recorded on the job row. Only then may authenticated
   tests be generated.
4. **Strict tenant isolation of knowledge.** Everything the crawler learns is
   `tenant_id`-scoped under RLS. The Test Writer has **no code path to the
   shared/global selector pool** (`is_shared: true, tenant_id: NULL`).
   Knowledge of a customer's app — especially behind login — never leaks
   cross-tenant.
5. **Never propose an unproven test.** Every generated test is validated by a
   real run through the existing worker before it appears as a draft.

## 3. Service architecture

Same deployment-seam pattern as screenshot/persistence: logic in a module,
thin queue-consumer entrypoint, own Dockerfile, env-overridable queue name.

```
src/modules/test-writer/
  interfaces.ts                 # job payloads, pipeline types (this spec §5)
  pipeline.ts                   # per-job orchestration across phases
  recon/crawler.ts              # BFS + interactive probing
  recon/safety.ts               # interaction safety classifier (hard gate)
  recon/auth-session.ts         # login-recipe execution + session verification
  comprehend/classifier.ts      # per-page purpose/capabilities
  comprehend/synthesizer.ts     # App Brief + journeys
  plan/test-planner.ts          # scenario matrix
  write/scenario-writer.ts      # NL step generation grounded in knowledge
  write/compile-gate.ts         # LearnedCompiler validation + one repair pass
  write/dedup.ts                # exact-hash + embedding dedup vs existing cases
  validate/validation-runner.ts # enqueue kaizen-runs jobs, await terminal status
  __tests__/
src/services/test-writer/index.ts   # BullMQ consumer on kaizen-testwriter
src/api/routes/test-writer.ts       # analyze / suggest / job-status routes
Dockerfile.testwriter               # Playwright base (same as Dockerfile.worker)
```

- **Browser**: the service instantiates its **own `BrowserPool`**
  (`src/workers/browser-pool.ts` is service-agnostic). Concurrency 1–2. It
  never shares the run-worker's pool — long-lived crawl page loads must not
  starve run throughput.
- **LLM**: exclusively via `ILLMGateway` (new methods; see companion specs).
  All tokens flow through the gateway → `PostgresBillingMeter`, so Test Writer
  spend counts against the tenant budget by construction.
- **docker-compose**: new `testwriter` service, Playwright base image,
  `DISABLE_INPROCESS_CONSUMERS` not applicable. npm scripts `dev:testwriter` /
  `start:testwriter`.

## 4. Queue contract

Added to `src/queue/index.ts`, same style as existing queues:

```ts
export const TESTWRITER_QUEUE_NAME =
  process.env.KAIZEN_TESTWRITER_QUEUE ?? 'kaizen-testwriter';

export type TestWriterJobPayload = {
  jobId: string;              // generation_jobs.id — created by the API before enqueue
  tenantId: string;
  suiteId: string;
  targetUrl: string;
  scope: 'public' | 'authenticated';
  loginCaseId?: string;       // required when scope === 'authenticated'
  authConsent: boolean;       // must be true when scope === 'authenticated'
  options: {
    maxPages: number;         // default 30, hard cap 50
    maxScenarios: number;     // default 6, hard cap 10
    includeNegative: boolean; // default true
    safeMode: boolean;        // default true — graduated safety filter (generation spec §4.2)
    validate: boolean;        // default true — self-validation runs
    planApproval: 'review' | 'auto'; // default 'review' on first analyze — pause after PLAN
  };
};
```

Job options: `attempts: 1` (unlike the run queue's 3). A recon/generation job
is expensive LLM work; failures are recorded on the `generation_jobs` row and
retried only by explicit user action — never blindly.

## 5. API surface

`src/api/routes/test-writer.ts`, registered in `src/api/server.ts`:

| Route | Auth | Behavior |
|---|---|---|
| `POST /suites/:suiteId/analyze` | JWT (`requireAuth`) | Full pipeline: recon → comprehend → plan → write → validate. Body `{ targetUrl, scope?, loginCaseId?, authConsent?, options? }` (Zod). Enforces the tenant token budget exactly like `POST /cases/:caseId/run` (402 `INSUFFICIENT_TOKENS`). Inserts `generation_jobs` row (`status='queued'`), enqueues, returns `202 { jobId }`. |
| `POST /suites/:suiteId/suggest` | JWT | Scoped generation: body `{ pageUrl, options? }`. If Site Knowledge exists for the suite, runs PLAN/WRITE/VALIDATE scoped to that page. If none exists, behaves as `analyze` (recon-first is non-negotiable). |
| `GET /testwriter/jobs/:jobId` | JWT | Job status + `report` JSONB + `test_plan` JSONB. Polled by the web UI (same 1.5–2s pattern as `use-run-poller`). |
| `GET /suites/:suiteId/jobs` | JWT | Job history for the suite. |
| `POST /testwriter/jobs/:jobId/plan-approval` | JWT | Resumes a job paused at `awaiting_plan_approval`. Body `{ approvedScenarios: string[], notes?: string }` — WRITE/VALIDATE run only for approved plan entries; notes ride into the WRITE prompt (delimited as untrusted data). 409 if the job is not awaiting approval. |

`POST /suites/:suiteId/analyze` additionally accepts `initBrief?: string`
(≤ 8k chars) — the tenant's "describe your app" text (§12), secret-scrubbed on
intake, distilled and stored before the job is enqueued.

Validation rule: `scope === 'authenticated'` requires `loginCaseId` AND
`authConsent === true`, else 400. Consent + scope are persisted on the job row
(audit trail).

## 6. Data model (migration `028_test_writer.sql`)

- `ALTER TYPE run_trigger ADD VALUE 'testwriter'` — validation runs are
  attributed to the Test Writer and excluded from customer run lists
  (`WHERE triggered_by <> 'testwriter'` in `GET /runs`). NOTE: the new enum
  value must NOT be referenced in the same migration file (PG16 allows ADD
  VALUE in a transaction, but not use of the value in that transaction).
- `generation_jobs` — one row per analyze/suggest job: tenant/suite scope,
  target URL, `scope`, `auth_consent`, `login_case_id`, status
  (`queued|running|completed|failed|blocked`), `options`, `report`,
  `test_plan` JSONB, error, timestamps. RLS `tenant_isolation`.
- `test_cases` lifecycle columns — see `../tests-ux/spec-draft-review-ux.md`:
  `status ('active'|'draft'|'validating'|'rejected'|'archived')`, `origin
  ('user'|'generated')`, `generation_job_id`, `validation_run_id`.

Site-model tables (`site_pages`, `page_elements`, `page_links`, `app_briefs`)
are migration `029_site_model.sql` — see spec-comprehension-knowledge-model.md.

> **Re-keyed 2026-08-12 (`spec-app-entity.md`, migration 036).** Site knowledge
> moves from `(tenant_id, suite_id)` to `(tenant_id, app_id)` — an `apps` row
> owns its origins (`app_origins`), suites carry a sticky `app_id`, and
> `generation_jobs` records the job's `app_id` row-authoritatively. Tests,
> drafts, jobs, `tenant_brief`, and consent flags remain suite-owned. 036 also
> retrofits `FORCE ROW LEVEL SECURITY` onto all tenant tables (RLS is currently
> inert under the table-owner runtime role).

## 7. Shared helper extraction

The case-creation SQL inside `POST /suites/:suiteId/cases`
(`src/api/routes/test-cases.ts:244` — inserts into `test_cases`, `test_steps`,
`test_case_steps` with immutable versioning) is extracted into
`src/db/case-writer.ts` and used by both the API route and the Test Writer's
draft-writer. One implementation of the versioned-steps invariant, two callers.

## 8. Job lifecycle & report

```
queued → running → awaiting_plan_approval → running → completed
                 │  (planApproval='review';        ↘ failed
                 │   resumes via plan-approval     ↘ blocked
                 │   endpoint; 7-day timeout
                 │   → failed:plan_approval_timeout)
                 ↘ failed   (pipeline error; error column populated)
                 ↘ blocked  (challenge detected / robots disallow / login failed)
```

`generation_jobs.report` JSONB (written incrementally, final on completion):

```jsonc
{
  "recon":      { "pagesCrawled": 24, "pagesBlocked": 1, "probesPerformed": 61, "authScope": "public" },
  "comprehend": { "pagesClassified": 24, "journeys": 4 },
  "plan":       { "scenariosPlanned": 9 },
  "write":      { "generated": 9, "safetyRejected": 1, "compileRejected": 1, "deduped": 2 },
  "validate":   { "proposed": 4, "rejected": [ { "name": "...", "reason": "...", "runId": "..." } ] },
  "tokenUsage": { "recon": 0, "comprehend": 8200, "plan": 1900, "write": 5400, "validationRuns": 12800 }
}
```

Cost visibility is a requirement, not a nicety: every phase reports tokens.

## 9. Cost & budget controls

- Pre-flight: same `usageThisMonth()` vs `llm_budget_tokens_monthly` 402 gate
  as the run-trigger routes.
- Hard caps: `maxPages` ≤ 50, `maxScenarios` ≤ 10, ≤ 10 steps per scenario
  (enforced in the write-phase prompt contract and post-validated).
- Validation runs execute on a cold site (worst case L5 LLM resolution per
  step) — bounded by scenario caps and 2-run concurrency with a 5-minute
  per-run timeout. Side benefit: validation runs warm the tenant's selector
  cache, so approved drafts run fast on their first real execution.

## 10. Phasing

| Phase | Scope |
|---|---|
| P0 | These specs + migrations 028/029. |
| P1 | RECON engine: crawler + safety classifier + interactive probing + Site Knowledge storage (public scope only). |
| P2 | COMPREHEND + PLAN + WRITE + VALIDATE + draft review UX + Suggest/Analyze wiring. |
| P3 | Authenticated scope: login-recipe execution, consent flow, logout blocklist, session verification, authenticated generation. |
| P4 | Bug creation / notifications (`../integration/spec-run-notifications.md`) — independent, parallel. |
| P5 | MAINTAIN: scheduled re-crawl + content-hash diffing, coverage endpoint, stale-test flagging (implements `RunTrigger 'schedule'` + `src/jobs/`). |

## 11. Non-goals (v1)

- No multi-domain crawling (one origin per suite).
- No visual-regression or screenshot-diff test generation.
- No API-level (non-UI) test generation.
- No automatic promotion of drafts — a human approves every generated test.
- No writes to the shared/global selector pool from any Test Writer code path.

## 12. Init Brief — user-provided system context (added 2026-08-06)

A human QA reads the docs on day one, not just the app. The crawl tells Kaizen
what the app IS; the Init Brief tells it what the app is FOR and what matters.

- Intake: `initBrief` free text on `POST /suites/:suiteId/analyze` (§5).
  Document upload (PDF/MD) is a deferred follow-up.
- **Secret scrubbing on intake**: credential/API-key/token patterns detected →
  warn in the response + redact BEFORE storage or any prompt.
- Distillation: one mini-model call → structured, tenant-scoped `tenant_brief`
  JSONB stored on the suite (migration 032): `{ purpose, roles, criticalFlows,
  businessRules, priorities, cautions }`. Fed into `synthesizeAppBrief` and
  `planScenarios` as a second knowledge source.
- **Grounding rule**: the brief steers priorities and journey selection; WRITE
  still references only CRAWLED elements. A brief-described flow the crawl
  didn't observe is reported as a **coverage gap** ("described but not
  observed — behind auth? deeper crawl?") — itself a QA deliverable.
- Brief text is untrusted input (§13.3) — delimited, instruction-ignoring.

## 13. Security & data posture (added 2026-08-06; priority order set by product owner)

1. **Customer data confidentiality (TOP)**: `tenant_brief`, site knowledge, and
   App Briefs are proprietary customer data — tenant-scoped under RLS, never in
   any shared table, never in another tenant's prompt context, excluded from
   cross-tenant logs. LLM provider posture: API-tier no-training/DPA terms,
   documented for security reviews; tenant-pinned endpoints are a future
   enterprise option. Credentials (P3): encrypted at rest, never logged, never
   in reports.
2. **Safe action on customer systems**: consent-gated mutations (per-suite
   `allow_synthetic_data`, generation spec §6.2), graduated safety filter,
   stop-before-the-money-step skeletons, and a reconstructable action audit
   trail (run_events + generation_jobs).
3. **Prompt-injection hardening**: crawled text (titles, headings, accessible
   names, form labels) AND brief text are attacker-influenceable and flow into
   frontier prompts — always delimited as untrusted data with an explicit
   ignore-embedded-instructions rule; scenario names/rationales sanitized
   before UI display; a hostile-page + hostile-brief fixture suite ships with
   P2 tests.
4. **Access control**: analyze/consent/approval ride the existing JWT +
   membership-role machinery; consent flags recorded on job rows for audit.

**Data doctrine — "signals, not content"**: per-tenant data is a PRODUCT asset
(monetizes via retention); only derived, tenant-free pattern telemetry may ever
cross tenants (aggregate counters, ≥N-tenant threshold, opt-out flag) — the
machinery is deferred, but provenance stamps (`test_plan.source`, future
`scenario_archetype_id`) ship with P2 so the telemetry clock starts now.
Artifact classification (content / derived / telemetry + retention class) for
everything this service produces lands in the platform data-handling spec (P6);
until then: screenshots and site-model rows live until re-crawl or tenant
offboarding.
