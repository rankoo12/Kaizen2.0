You are a collaborator on the Kaizen project. Read everything below before writing a single line of code.

> **Read first:** `docs/CLAUDE.md` (orientation + pre-implementation protocol)
> **Then:** `docs/summaries/00-index.md` (modular spec map)
>
> Sections below labelled "stale" describe an earlier phase of the project
> and are kept only for historical interface / convention context. Trust
> `docs/CLAUDE.md`, `docs/summaries/`, and `docs/specs/` over anything
> here when they disagree.

─── PROJECT ────────────────────────────────────────────────────────────

Kaizen is an AI-powered SaaS platform for self-healing UI test automation.
Users write tests in plain English. Kaizen uses an LLM to locate UI elements,
executes tests in a real Chromium browser via Playwright, and automatically
heals broken tests when the UI changes — without human intervention.

Source of truth (current): the modular spec tree under `docs/specs/`.
Source of truth (legacy, retained for historical context only):
docs/kaizen-spec-v1.md.

Default branch: main. Working branches follow `type/scope/short-description`
(see Conventions). The "Current branch" line in older versions of this file
was a snapshot from phase 1 and is no longer accurate.

─── WORKING METHODOLOGY ────────────────────────────────────────────────

1. SOLID — applied to every module:
   - Modules communicate ONLY through TypeScript interfaces (no cross-module
     implementation imports — ever).
   - Each class has one reason to change. Extend via new implementations,
     not by modifying existing interfaces.

2. SDD (Spec-Driven Development):
   - docs/kaizen-spec-v1.md is the source of truth. If the spec and the
     code disagree, fix the spec first, then the code.
   - Interfaces exist before implementations. Never write an implementation
     for an interface that hasn't been defined and checked against the spec.
   - If you identify a gap in the spec, raise it explicitly — do not silently
     fill it with an assumption.

─── CONVENTIONS ────────────────────────────────────────────────────────

Commit format:   feat/fix/chore(scope) : short description
                 "optional longer description"
Branch format:   type/scope/short-description  (kebab-case)
Scopes:          core, api, ui, worker, db, infra, config

─── TECH STACK ─────────────────────────────────────────────────────────

Runtime:         Node.js 20 / TypeScript (strict mode, CommonJS)
HTTP:            Fastify v4
Browser:         Playwright (runtime dependency — the product uses it)
Job queue:       BullMQ (backed by Redis via ioredis)
Database:        PostgreSQL (Neon in prod; local Docker pgvector/pgvector:pg16)
Cache:           Redis (Upstash in prod; local Docker redis:7-alpine)
Vector DB:       Pinecone (namespace-per-tenant)
LLM:             OpenAI / Anthropic (abstracted behind ILLMGateway — callers
                 never know which provider is in use)
Storage:         Cloudflare R2 (S3-compatible)
Logging:         pino (structured JSON; no string-interpolated messages)
Observability:   OpenTelemetry (traces + metrics)
Testing:         Jest (unit tests of pure logic), Playwright Test (integration/E2E)

─── ARCHITECTURE ───────────────────────────────────────────────────────

Modular monolith (v1). All modules in one process; hard interface boundaries
for future service extraction.

src/
├── api/                   # Fastify HTTP layer
├── modules/
│   ├── test-compiler/     # NL text → StepAST
│   ├── dom-pruner/        # Playwright Page → CandidateNode[]
│   ├── element-resolver/  # StepAST + DOM → SelectorSet (cache-first)
│   ├── execution-engine/  # StepAST + SelectorSet → browser action
│   ├── healing-engine/    # ClassifiedFailure → HealingResult
│   ├── llm-gateway/       # All outbound LLM calls (single choke point)
│   ├── billing-meter/     # Append-only billing event log
│   └── observability/     # Logging, tracing, metrics
├── workers/               # BullMQ job consumers (separate Node.js process)
├── types/index.ts         # ALL shared types — single source of truth
├── jobs/                  # Scheduled batch jobs (Phase 2+)
db/migrations/             # SQL migration files (001_initial_schema.sql applied)
scripts/migrate.ts         # Custom migration runner

Request flow (test run from CI):
  CLI → POST /runs
    → TestCompiler.compile(steps)
    → for each step:
        ElementResolver.resolve(step, context)
          → [cache miss] → DOMPruner.prune(page) → LLMGateway.resolveElement()
        ExecutionEngine.executeStep(step, selectorSet, page)
          → [failure] → HealingEngine.heal(failure, context)
    → persist RunResult
    → BillingMeter.emit(events)

─── INTERFACES (Section 6 of spec — already implemented in src/modules/) ──

All 8 interfaces exist. Do not modify them without a spec update first.

ITestCompiler   — compile(rawText) → StepAST
                  compileMany(steps[]) → StepAST[]

IDOMPruner      — prune(page, targetDescription) → CandidateNode[]

IElementResolver — resolve(step, context) → SelectorSet
                   recordSuccess(hash, domain, selector)
                   recordFailure(hash, domain, selector)

IExecutionEngine — executeStep(step, selectorSet, page) → StepExecutionResult

IHealingStrategy — canHandle(failure) → boolean
                   heal(failure, context) → HealingAttempt
IHealingEngine   — heal(failure, context) → HealingResult

ILLMGateway     — resolveElement(step, candidates, tenantId) → LLMResolutionResult
                  compileStep(rawText, tenantId) → StepAST

IBillingMeter   — emit(event) → void
                  getCurrentUsage(tenantId) → TenantUsage
                  isOverBudget(tenantId, eventType) → boolean

IObservability  — startSpan(name, attrs?) → Span
                  log(level, event, data)
                  increment(metric, labels?)
                  histogram(metric, value, labels?)

─── DATA MODEL (key facts) ──────────────────────────────────────────────

- Migration 001_initial_schema.sql is applied. All tables exist.
- test_steps rows are IMMUTABLE. Edits create new rows (parent_step_id chain).
- test_case_steps join table tracks which step version is currently active.
- selector_cache: (tenant_id, content_hash, domain) → SelectorSet.
  Confidence decay: sliding window of last 50 outcomes, exponential recency weighting.
- billing_events is append-only (enforced by Postgres CREATE RULE).
- RLS: app.current_tenant_id set from JWT per DB session. All tables policy-enforced.
- page fields in types are typed as `unknown` at the interface layer.
  Implementations cast to Playwright Page internally.

─── MULTI-TENANCY ───────────────────────────────────────────────────────

- Shared Postgres with RLS. tenant_id on every table.
- Vector store: one Pinecone namespace per tenant.
- Shared knowledge pool (enterprise opt-in): separate 'shared' Pinecone namespace.
- Redis keys always prefixed with tenantId.

─── CURRENT STATE (stale — see git log + docs/specs/ for actual state) ──

The "completed / not started" lists previously here were a phase-1
snapshot and are no longer accurate. All eight interfaces, the
LLM gateway, billing meter, element resolver, healing engine, worker
job, full API routes, and the multi-tenant identity layer have shipped
since. Do **not** treat this section as a checklist.

To learn the current state:

  - `git log --oneline -30` for recent work
  - `docs/specs/` for active and shipped feature specs (grouped by domain)
  - `docs/known-issues/` for accepted limitations
  - `docs/summaries/` for module-level architecture summaries

─── PHASE 1 MILESTONE (historical) ──────────────────────────────────────

"Run 'open youtube, search for cats, press enter' from a curl command."
One tenant hardcoded. No auth. No caching (every resolve hits LLM).
This milestone is long-since shipped and superseded.