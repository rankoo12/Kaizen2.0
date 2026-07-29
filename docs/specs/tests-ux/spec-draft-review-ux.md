# Spec — Draft Review UX (generated-test lifecycle in the web UI)

Created: 2026-07-29
Branch: `feat/test-writer/p0-specs`
Status: Draft — design agreed; implementation not started.

> Companion to `../test-writer/spec-test-writer-service.md` and
> `../test-writer/spec-generation-pipeline.md`. Backend lifecycle columns land
> in migration `028_test_writer.sql`.

## 1. Case lifecycle

Generated tests live on the existing `test_cases` table (NOT a parallel
table): validation runs need `runs.case_id`, approval is a one-column flip,
and the review UI reuses the existing case editor.

```
                    (test writer)                (user)
  validating ──▶ draft ─────▶ active            approve
        │           └───────▶ archived          dismiss
        └──────▶ rejected                       (auto, failed validation)
  user-created cases are born 'active', origin='user'
```

New columns on `test_cases` (migration 028):

| Column | Values | Notes |
|---|---|---|
| `status` | `active` \| `draft` \| `validating` \| `rejected` \| `archived` | default `active` — existing rows unaffected |
| `origin` | `user` \| `generated` | default `user` |
| `generation_job_id` | UUID nullable | provenance link |
| `validation_run_id` | UUID nullable | the run that proved the draft |

Filtering rules (backend):
- Suite runs / run pickers / `POST /cases/:caseId/run` operate only on
  `status='active'` cases (400 on non-active).
- `GET /suites/:suiteId/cases` returns all statuses with a `status` filter
  param; default UI view shows `active` + `draft`.
- Validation runs (`triggered_by='testwriter'`) are excluded from `GET /runs`
  lists but reachable by id.

Approval endpoints (extend `src/api/routes/test-cases.ts`):
- `PATCH /cases/:caseId` accepts `status: 'active'` (approve draft) and
  `status: 'archived'` (dismiss). Transitions restricted:
  `draft → active|archived`, `rejected → archived`. No other status writes via
  API (`validating`/`rejected` are Test-Writer-owned).

## 2. UI surfaces

### 2.1 "Suggest" / "Analyze" entry (new-test-screen)

The disabled Sparkles "Suggest" button
(`packages/web/src/components/organisms/new-test-screen.tsx:275`) becomes
live:
- In a suite with no Site Knowledge: opens the **Analyze app** dialog —
  target URL (prefilled from the case's base URL), scope selector (public /
  authenticated with login-case picker + explicit consent checkbox whose copy
  states that Kaizen will log in and explore behind authentication), and a
  recommendation to use a staging URL. Submits `POST /suites/:id/analyze`.
- With existing knowledge: "Suggest tests for this page" submits
  `POST /suites/:id/suggest { pageUrl }`.

### 2.2 Generation job progress

A job panel (suite level) polling `GET /testwriter/jobs/:jobId`
(reuse the `use-run-poller` pattern, 2s):
- Phase progress: Recon (pages crawled / cap) → Comprehend → Plan → Write →
  Validate (n of m runs done).
- **The test plan is shown as soon as PLAN completes** — the user sees "what I
  intend to test and why" (name, kind, priority, rationale) while validation
  is still running.
- Terminal: proposed drafts + rejected scenarios with reasons (compiler error,
  failed validation with run link, duplicate-of, safety-filtered) + token
  usage per phase.

### 2.3 Draft review

In the suite's case list:
- Drafts get a distinct badge (`draft`, Sparkles icon) + the generation
  rationale and a link to the green validation run (evidence, incl.
  screenshots — the user can SEE the test working before approving).
- Actions: **Approve** (→ active), **Edit then approve** (existing editor;
  editing creates new step versions per the immutable-steps model — a draft
  edit does NOT re-validate automatically in v1; the UI notes this),
  **Dismiss** (→ archived).
- Rejected scenarios appear in the job report only (not the case list) with
  their failure evidence.
- Tier-2 `expected-fail` drafts (see generation spec §3.1) show a warning
  badge and cannot be approved to `active` — review-only until
  `expected_outcome` support exists.

## 3. Types (frontend mirror)

`packages/web/src/types/api.ts` additions: `CaseStatus`, `CaseOrigin`,
`GenerationJob { id, status, scope, report, testPlan, createdAt, … }`;
`CaseSummary`/`CaseDetail` gain `status`, `origin`, `validationRunId`.
New hooks: `use-generation-job.ts` (poll), `use-suggest.ts` (trigger).
All backend traffic via the existing `/api/proxy` route — no direct calls.

## 4. Testing

- API: transition matrix unit tests (draft→active ok; validating→active 400;
  run-trigger on draft 400; list filtering by status).
- Web: job panel renders each phase state from fixture payloads; draft badge +
  approve/dismiss flows; consent checkbox required before authenticated
  analyze submits.
- Live (P2 exit): full loop — analyze → review plan → approve one draft →
  run it as a normal suite case.
