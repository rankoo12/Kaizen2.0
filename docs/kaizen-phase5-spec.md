# Phase 5 — CI/CD & Observability
**Branch:** `feat/core/phase-5-cicd-observability`  
**Spec ref:** `kaizen-spec-v3.md` §16, §17, §Phase 5

---

## Goal

Transition Kaizen from a backend engine into a fully usable developer product. Teams must be able to trigger tests automatically from their CI pipelines, view results natively in their PRs, and receive fast, streaming feedback via a CLI. Additionally, platform owners must have deep observability via OpenTelemetry and automated telemetry-driven workflows like the LLM feedback loop.

## Milestone Definition

The milestone is met when:
1. `npx @kaizen/cli run test-suite-id --api-key=...` triggers a run and streams SSE logs to the terminal, exiting 0 on success and 1 on failure.
2. The GitHub action `kaizen-hq/action` successfully runs a suite and annotates PRs with JUnit test failures.
3. Webhooks fire upon run completion delivering the `{ runId, status, duration }` payload.
4. Traces and metrics (including prompt token spend and cache hit ratios) are actively exported to an OTLP endpoint.
5. The `feedback-loop` batch job runs successfully, updating LLM prompt success rates in the database.

---

## What Already Exists (Do Not Rebuild)

| Existing | Location |
|---|---|
| Core execution & self-healing | `execution-engine`, `healing-engine` |
| API layer with auth | `api/routes/auth.ts`, JWT middleware |
| Sync run trigger endpoint | `POST /runs` |
| Single run fetch endpoint | `GET /runs/:id` |
| Basic Pino logging | `PinoObservability` |

**Gaps to close:**
1. No Server-Sent Events (SSE) endpoint to stream run results.
2. No CLI package (`packages/cli`).
3. No native JUnit or JSON CLI reporters.
4. No GitHub Action published or implemented.
5. No Webhook dispatch service or database tables for webhook configurations.
6. OpenTelemetry integration is entirely missing (currently just Pino wrappers).
7. No feedback loop job to evaluate `prompt_templates` success rates.
8. No A/B testing infrastructure for prompts.

---

## 1. REST API: Server-Sent Events (SSE)

File: `src/api/routes/runs.ts`

**Add endpoint:** `GET /runs/:id/stream`

**Logic:**
- Use Fastify SSE plugin or native Node.js EventStream responding with `Content-Type: text/event-stream`.
- Subscribe to the Redis pub/sub channel for `run:{id}`.
- Emit events as they occur: 
  - `step_started`
  - `step_completed` (includes status, duration, caching details)
  - `healing_attempted`
  - `run_completed`
- Close connection upon `run_completed`.

---

## 2. CLI Package (@kaizen/cli)

Location: `packages/cli/` (New directory to create a monorepo setup, or separate deployable project)

**Stack:** Commander.js, Zod, EventSource (for SSE)

**Commands:**
- `kaizen login --api-key <key>`: stores key in `~/.kaizen/config.json`.
- `kaizen run <suite-id>`:
  - Dispatches `POST /runs`
  - Opens SSE connection to `GET /runs/:id/stream`
  - Prints live streaming updates to the terminal using ANSI colors (green for pass, yellow for heal, red for fail).
  - Collects final results into memory.
  - Flags: 
    - `--reporter=junit` (writes `kaizen-results.xml` to disk)
    - `--reporter=json` (writes `kaizen-results.json` to disk)
    - `--fail-on-heal` (exits 1 even if the test passed via healing, useful for strict mode).

---

## 3. Webhook Integration

**Database Migration (`db/migrations/007_webhooks.sql`):**
```sql
CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL, -- used for HMAC signature
  events TEXT[] NOT NULL, -- e.g., ['run.completed', 'run.failed']
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**Service Implementation:**
File: `src/modules/webhooks/webhook.service.ts`
- Dispatched asynchronously via specialized BullMQ queue (`kaizen-webhooks`).
- Payload signed with `x-kaizen-signature: sha256=HMAC(body, secret)`.
- Retry logic: exponential backoff, up to 3 attempts.

---

## 4. GitHub Action

Location: `.github/actions/run-tests/` or separate repository.

**`action.yml`:**
```yaml
name: 'Kaizen Test Runner'
description: 'Run semantic UI tests on your PR'
inputs:
  api_key:
    required: true
  suite_id:
    required: true
  target_url:
    required: false
runs:
  using: 'node20'
  main: 'dist/index.js'
```

**Implementation:**
- Uses `@actions/core` and the `@kaizen/cli` core logic.
- Polls or streams results. If tests fail, uses `@actions/github` to annotate the PR files or add a comment with the failure summaries and screenshot links.

---

## 5. Observability (OpenTelemetry)

Currently, `IObservability` uses `PinoObservability`. We need a true OpenTelemetry implementation.

File: `src/modules/observability/otel.observability.ts`

**Requirements:**
- Implement `IObservability` interface.
- Expose an OTLP/HTTP exporter pointing to `process.env.OTEL_EXPORTER_OTLP_ENDPOINT`.
- Wrap spans correctly (propagate trace context across module boundaries).
- Send metrics (cache hits, durations, billing usage) as OTel Metrics.
- **Wire-up:** In `server.ts` and `worker.ts`, initialize the global OTel SDK *before* importing fastify or other libraries to enable node auto-instrumentation.

---

## 6. Feedback Loop Job & Prompt A/B Testing

**Database Migration (`db/migrations/008_prompt_ab.sql`):**
```sql
-- Already exists: prompt_templates table. Need to add A/B wiring.
ALTER TABLE step_results ADD COLUMN prompt_template_id UUID REFERENCES prompt_templates(id);
```

File: `jobs/feedback-loop.ts`

**Logic:**
- Runs nightly.
- Queries `step_results` joined on `prompt_templates`.
- Calculates success rates for all templates used in the last 24 hours.
- Updates `prompt_templates.success_rate` and `prompt_templates.sample_count`.
- If an experimental template (version > base) achieves statistical significance over the base template (e.g., > 2% improvement over 500 runs), send an internal notification to engineering to promote it.

---

## 7. Execution Order

Follow strictly in this order — each step depends on the previous:

- [ ] **Step 1:** Modify API repo to add `/runs/:id/stream` SSE endpoint.
- [ ] **Step 2:** Write `packages/cli` implementation (auth, run, streaming logs).
- [ ] **Step 3:** Add JUnit/JSON reporter logic to the CLI.
- [ ] **Step 4:** Build the GitHub Action encapsulating the CLI logic.
- [ ] **Step 5:** Write migration `007_webhooks.sql` and `webhook.service.ts`. Wire into worker completion.
- [ ] **Step 6:** Replace Pino metrics with real `OtelObservability` exports.
- [ ] **Step 7:** Write migration `008_prompt_ab.sql`.
- [ ] **Step 8:** Write `jobs/feedback-loop.ts`. Add npm script `brain:feedback`.
- [ ] **Step 9:** Execute E2E integration verification combining CLI run, SSE stream, webhook dispatch, and PR annotation.

---

## 8. Files to Create / Modify

| Action | File |
|---|---|
| MODIFY | `src/api/routes/runs.ts` |
| CREATE | `packages/cli/...` |
| CREATE | `db/migrations/007_webhooks.sql` |
| CREATE | `src/modules/webhooks/webhook.service.ts` |
| CREATE | `[repos/kaizen-action]/action.yml` |
| CREATE | `src/modules/observability/otel.observability.ts` |
| CREATE | `db/migrations/008_prompt_ab.sql` |
| CREATE | `jobs/feedback-loop.ts` |
