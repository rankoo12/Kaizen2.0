# Spec — Generation Pipeline (Phases 3–5: PLAN / WRITE / VALIDATE)

Created: 2026-07-29
Branch: `feat/test-writer/p0-specs`
Status: Draft — design agreed; implementation not started.

> Companion to `spec-test-writer-service.md`. Reads Site Knowledge
> (`spec-comprehension-knowledge-model.md`); produces draft `test_cases`
> reviewed per `../tests-ux/spec-draft-review-ux.md`.

## 1. Principle: never propose an unproven test

Every generated test is (a) compiled through `LearnedCompiler` (it must be
valid Kaizen NL), (b) safety-filtered, (c) deduped, and (d) **executed as a
real run through the existing worker** before the user ever sees it. A test
that cannot prove itself is rejected with a reason, not softened into a draft.
This is `/dogfood` culture applied to generation: a battery of suggestions
that all "pass" without validation is a failed battery.

## 2. Phase 3 — PLAN

`plan/test-planner.ts`, gateway method:

```ts
// ILLMGateway
planScenarios(input: PlanInput, tenantId: string): Promise<PlannedScenario[]>;

type PlanInput = {
  appBrief: AppBrief;                  // incl. graph-verified journeys
  capabilitiesByPage: Record<string, string[]>;
  existingCaseNames: string[];         // dedup steering
  scope: 'public' | 'authenticated';
  maxScenarios: number;
};

type PlannedScenario = {
  name: string;
  journey: string | null;              // journey name or null for page-local
  kind: 'happy' | 'negative' | 'edge';
  priority: 'critical' | 'high' | 'normal';
  rationale: string;                   // why a QA engineer would write this
  targetPages: string[];               // urlNormalized values it will touch
};
```

The plan is stored on `generation_jobs.test_plan` JSONB **before** any steps
are written — a reviewable artifact ("here is what I intend to test and why"),
shown in the UI alongside results. Planned scenarios touching
`requires_auth` pages are dropped (and reported) unless the job has
authenticated scope + consent.

## 3. Phase 4 — WRITE

`write/scenario-writer.ts`, gateway method `generateScenarios(...)`. Per
planned scenario, one prompt containing:

- The scenario's plan entry (name, kind, rationale, target pages).
- **Grounding**: the target pages' element surveys from `page_elements`
  (role + name + revealed_by), form summaries, and the `page_links` path —
  the generated step says "click the 'Proceed to payment' button" because that
  element exists on that page in the graph. Selectors are NEVER given to the
  LLM; steps reference elements in natural language only (NL is the interface;
  resolution happens at run time through the normal resolver chain).
- **The action grammar**: all 27 `StepAction`s with one canonical NL example
  sentence each, phrased to hit `LearnedCompiler`'s cached compilation paths.
  (`assert_count` is excluded until `feat/engine/assert-count` lands — see
  known gap in `src/types/index.ts:41`.)
- `{{token}}` seed variables from `generateFormData()`
  (`src/modules/test-data/generate.ts`) — typed values must be tokens
  (`{{email}}`, `{{password}}`), not literals.
- Safe-mode rules (§5) and the ≤ 10 steps/scenario cap.

Output:

```ts
type GeneratedScenario = {
  planRef: string;                     // PlannedScenario.name
  name: string;
  kind: 'positive' | 'negative';
  steps: string[];                     // NL sentences — THE interface
  expectation:
    | { outcome: 'pass' }
    | { outcome: 'fail'; failStepIndex: number; reason: string };
  rationale: string;
};
```

### 3.1 Negative tests — two-tier semantics

- **Tier 1 (prompt-enforced default)**: negatives are phrased as **positive
  assertions of the rejection state** — "type an invalid email…, click the
  submit button, **verify the error message is visible**" / "**verify the url
  contains /login**" (page didn't advance). These validate green and ship as
  normal tests: a correct negative test IS green when the app behaves
  correctly. Uses existing `assert_visible` / `assert_not_visible` /
  `assert_url` / `assert_text` actions.
- **Tier 2 (fallback, `expectation.outcome='fail'`)**: only when no observable
  rejection signal exists. Validation passes iff the run `failed` AND
  `step_results.step_index === failStepIndex` AND the failure class is an
  assertion failure (`LOGIC_FAILURE`) — element-not-found / timeout / infra
  failures mean the *test* is broken, not that the app resisted. Tier-2
  survivors are saved as drafts tagged `expected-fail` in the report and are
  **never auto-promotable** (they cannot run green in normal suites today; a
  future `test_cases.expected_outcome` column is the clean fix, out of scope).

## 4. Post-write gates (in order)

1. **Safety filter** (`write/`, reuses the destructive lexicon from
   `recon/safety.ts`): under `safeMode` (default true) reject scenarios whose
   steps match destructive verbs (delete, pay, purchase, publish, send,
   deactivate, transfer…). Validation runs execute REAL actions on the
   customer's URL. Opt-out is per-job, recorded in `generation_jobs.options`.
2. **Compile gate** (`write/compile-gate.ts`):
   `compiler.compileMany(scenario.steps)`. Any step that throws or produces an
   AST whose action/target/value fields are unusable → one repair round-trip
   (compile errors sent back to `generateScenarios` in repair mode) → still
   failing → scenario rejected with the compiler error in the report. Every
   proposed draft is guaranteed to compile to valid `StepAST[]`.
3. **Dedup** (`write/dedup.ts`): (a) exact — SHA-256 of normalized joined step
   texts vs existing suite cases; (b) semantic — embedding of
   `name + steps` vs existing cases' step text, cosine > 0.92 → dropped,
   reported as duplicate-of. Existing-case embeddings are computed at job time
   (suites are small; no schema addition in v1).

## 5. Phase 5 — VALIDATE

`validate/validation-runner.ts`:

1. Save each surviving scenario as a case via `src/db/case-writer.ts` with
   `status='validating'`, `origin='generated'`, `generation_job_id` set.
2. Compile (cached from the gate), `INSERT INTO runs (triggered_by='testwriter')`,
   enqueue `RunJobPayload` on the **existing `kaizen-runs` queue** with
   `seedVariables: generateFormData()`. Concurrency 2; per-run poll every 2s to
   terminal status, 5-minute timeout (the worker already writes terminal
   status — no new signaling infra; SSE upgrade rides the phase-5 work later).
3. Verdicts:
   - Positive: run `passed` → `status='draft'` + `validation_run_id`;
     `healed` → draft + flagged in report; `failed` → `status='rejected'` +
     failing step + run link in report.
   - Negative Tier 1: same as positive. Tier 2: per §3.1 rules.
   - Authenticated scenarios (P3): validated only under consent; their step
     chains begin with the login recipe's steps.
4. Validation runs are excluded from customer run lists:
   `WHERE triggered_by <> 'testwriter'` in `GET /runs`
   (`src/api/routes/runs.ts:113`); still reachable by id from the report.

Side benefit: validation runs warm the tenant's selector cache — an approved
draft's first real run resolves from cache, not the LLM.

## 6. Cost controls

- Pre-flight tenant budget 402 gate (same as `/cases/:caseId/run`).
- Caps: `maxScenarios` ≤ 10, ≤ 10 steps/scenario, 1 repair round-trip, 2-run
  validation concurrency, 5-min run timeout.
- All LLM calls via `ILLMGateway` → billed to the tenant by construction
  (NOT the `SYSTEM_TENANT_ID` carve-out the compiler uses — Test Writer
  compile calls bill the tenant).
- `tokenUsage` per phase in the job report.

## 7. Testing

Unit (mock gateway, mock queue):
- Compile gate: invalid step → repair → reject path; valid steps pass through.
- Safety filter adversarial: "delete my account and verify it is gone" →
  rejected under safe mode.
- Dedup: exact and near-duplicate scenarios dropped.
- Tier-2 verdict logic: failure at wrong step index → rejected; non-assertion
  failure class → rejected.

Live acceptance (P2 exit, `/dogfood` style):
- Analyze a real demo storefront: App Brief correct, plan reviewable, ≥ 3
  drafts proposed, all with green validation runs.
- A deliberately impossible planned scenario (seeded via test hook) is
  **rejected, not proposed** — the false-pass hunt applies to generation.
- Drafts are excluded from suite runs until approved.
- Token usage appears in the report and in `billing_events` for the tenant.
