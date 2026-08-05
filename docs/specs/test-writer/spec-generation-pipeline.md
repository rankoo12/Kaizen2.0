# Spec — Generation Pipeline (Phases 3–5: PLAN / WRITE / VALIDATE)

Created: 2026-07-29
Updated: 2026-08-06 — v2 after the generation-intelligence evaluation: structured-intent
generation, gate-stack redesign, plan-approval checkpoint, catalog prompt block, oracle
harvest, graduated safety split, metering fixes. Decisions approved by product owner.
Branch: `feat/test-writer/generation-pipeline`
Status: Design agreed; implementation not started.

> Companion to `spec-test-writer-service.md`. Reads Site Knowledge
> (`spec-comprehension-knowledge-model.md`) + the tenant Init Brief; instantiates
> patterns from `catalog-v1.md`; produces draft `test_cases` reviewed per
> `../tests-ux/spec-draft-review-ux.md`.

## 1. Principles

1. **Never propose an unproven test.** Every generated test is executed as a real run
   through the existing worker before the user sees it.
2. **Three filters, because each is blind to what the others catch.** The site graph is
   the *reality* filter (can't test what wasn't observed); the lint+judge gates are the
   *value* filter (VALIDATE is structurally blind to worthless tests — a vacuous test
   passes validation forever); VALIDATE is the *truth* filter (it actually runs).
3. **Judgment is the only thing bought with frontier tokens.** Exactly two frontier
   calls per job: `synthesizeAppBrief` and `planScenarios`. Everything else is
   deterministic or mini-model. Generation is capital expenditure — once per app —
   and validation runs warm the tenant's selector cache backwards.

## 2. Phase 3 — PLAN

`plan/test-planner.ts`, gateway method (FRONTIER tier, env-configurable model):

```ts
// ILLMGateway
planScenarios(input: PlanInput, tenantId: string): Promise<PlannedScenario[]>;

type PlanInput = {
  appBrief: AppBrief;                  // incl. graph-verified journeys
  tenantBrief: TenantBrief | null;     // distilled Init Brief (service spec §12) — priorities/rules
  capabilitiesByPage: Record<string, string[]>;
  existingCaseNames: string[];         // dedup steering
  scope: 'public' | 'authenticated';
  syntheticDataConsent: boolean;       // per-suite flag — gates signup/cart families
  maxScenarios: number;
};

type PlannedScenario = {
  name: string;
  journey: string | null;
  kind: 'happy' | 'negative' | 'edge';
  priority: 'critical' | 'high' | 'normal';
  rationale: string;                   // why a QA engineer would write this
  targetPages: string[];               // urlNormalized values it will touch
  source: { kind: 'catalog'; archetypeKey: string } | { kind: 'llm' };  // provenance
};
```

Prompt structure (static-prefix-first for provider prompt caching):
1. STATIC: action grammar + planning rubric + the **catalog block** (`catalog-v1.md`
   §Prompt-Block rendering, ~3–4k tokens) — instantiation guidance: prefer catalog
   patterns where the app's pages/capabilities satisfy an archetype's preconditions,
   but **reserve ~30% of `maxScenarios` for app-specific scenarios no catalog entry
   covers** (permanent — the guard against shipping every customer the same suite).
2. DYNAMIC (delimited as untrusted data — injection posture, service spec §13):
   App Brief, tenant brief, capabilities, existing case names.

Rules: scenarios touching `requires_auth` pages are dropped (and reported) unless the
job has authenticated scope + consent; signup/cart archetype families are planned but
marked validation-blocked unless `syntheticDataConsent` (§6.2). `source` provenance is
stored per scenario in `generation_jobs.test_plan`.

### 2.1 Plan-approval checkpoint (toggleable)

`options.planApproval: 'review' | 'auto'` — default **'review'** on a suite's first
analyze, 'auto' for re-analyses/CI. In review mode the job stops after PLAN with status
`awaiting_plan_approval`; nothing is written or executed yet.

- UI shows the scenario matrix (name/kind/priority/rationale/source); user approves,
  deselects, and may add free-text steering notes.
- `POST /testwriter/jobs/:jobId/plan-approval { approvedScenarios: string[], notes?: string }`
  resumes the job — WRITE/VALIDATE run only for approved entries; notes ride into the
  WRITE prompt (delimited as untrusted data).
- Deselections are recorded in `test_plan` (early human-preference telemetry).
- Jobs stuck in `awaiting_plan_approval` for 7 days are marked `failed` with reason
  `plan_approval_timeout` (report notes how to re-run).

## 3. Phase 4 — WRITE (structured intents)

**Product re-decision (recorded)**: NL remains the USER-facing interface — humans review
and edit English, and edited steps go through the normal compiler. But the LLM no longer
emits English internally. `write/scenario-writer.ts` calls `generateScenarios(...)`
(mini tier) which returns **structured intents**; a deterministic renderer emits both
the NL sentence and the StepAST. This kills the two structural failure modes (hallucinated
elements → schema error; negative polarity → a field, not a parse) and removes the
LLM re-compile of generated steps (~half the job's token cost in the v1 design).

```ts
type StepIntent =
  // closed union — one variant per StepAction; representative shapes:
  | { action: 'navigate'; url: string }                       // url must be a crawled urlNormalized
  | { action: 'click' | 'double_click' | 'hover' | 'check' | 'uncheck' | 'clear';
      elementId: string }                                     // MUST reference page_elements.id
  | { action: 'type' | 'select'; elementId: string; value: string }  // typed identity values MUST be {{seed}} tokens
  | { action: 'click_random'; targetDescription: string; captureAs: string }  // DESCRIPTION VARIANT (a): class of elements
  | { action: 'assert_visible' | 'assert_text' | /* … */;
      target: { elementId: string } | { description: string } // DESCRIPTION VARIANT (b): discover oracle
      /* value fields per action */ }
  | { action: 'assert_url' | 'assert_title'; value: string }
  | { action: 'drag_and_drop'; elementId: string; destinationElementId: string }  // two-target (landed on main 2026-08)
  | { action: 'press_key'; value: string }
  | { action: 'wait'; value: string };
// Full vocabulary: src/types/index.ts StepAction (32 actions incl. switch_tab/close_tab/
// drag_and_drop; assert_count excluded until the engine implements it).

type GeneratedScenario = {
  planRef: string;
  name: string;
  kind: 'positive' | 'negative';
  steps: StepIntent[];
  expectation: { outcome: 'pass' } | { outcome: 'fail'; failStepIndex: number; reason: string };
  rationale: string;
};
```

**Description-variant exemptions (schema-enforced, ONLY two)**:
(a) `click_random` targets — group semantics ("an add to cart button" names a CLASS of
elements) with mandatory `{{selectedItem}}`-style capture; (b) assertion targets that
**directly follow a state-changing action** — discover oracles: recon never submits
forms, so post-submit success/error states have no `page_elements` row to reference
(§5.1). Any other description-shaped step is a schema rejection.

**Renderer** (`write/canonical-templates.ts`): one canonical NL template per action,
phrased in the compiler's own canonical grammar. From each intent it emits
(1) the NL sentence — what the user sees/edits, and (2) the `StepAST` — constructed
directly (the writer knows action/target/value definitionally).

**AST persistence — the isolation-safe path**: constructed ASTs are stored on
`test_steps.compiled_ast` (column exists since 001). The run-trigger path
(`POST /cases/:caseId/run`, `src/api/routes/test-cases.ts`) is amended to prefer a
step's stored AST over `compiler.compileMany`. **No Test-Writer write ever touches the
global `compiled_ast_cache`** — rendered sentences embed tenant element names and URLs,
and that table is tenant-free (002: "Global dictionary — no tenant_id").

**Fallback path**: intents the template set can't express fall back to LLM-phrased NL
through the REAL compile gate (one repair round). Meter the fallback rate — it names the
next template to add. Fallback compiles bill the TENANT: parameterize `LearnedCompiler`'s
billing tenant (currently hardcoded `SYSTEM_TENANT_ID`, learned.compiler.ts:21) with the
system tenant as default so existing callers are unchanged.

Prompt contents for `generateScenarios` (per approved plan entry, mini tier): the plan
entry; the target pages' `page_elements` (id + role + name + revealed_by — NEVER
selectors) and form summaries; the `page_links` path; `{{seed}}` token list; the intent
schema; ≤ 10 steps/scenario cap; steering notes from plan approval (delimited).

### 3.1 Negative tests — two-tier semantics (unchanged from v1)

- **Tier 1 (default, prompt- and lint-enforced)**: negatives end in **positive
  assertions of the rejection state** ("verify the error message is visible" /
  "verify the url contains /login") — they validate green and ship as normal tests.
- **Tier 2 (fallback, `expectation.outcome='fail'`)**: only when no observable rejection
  signal exists. Valid iff the run `failed` at `failStepIndex` with an assertion-class
  failure (`LOGIC_FAILURE`). Tier-2 survivors are `expected-fail`-tagged drafts, never
  auto-promotable.

## 4. Gate stack (cheapest first; each catches what only it can)

1. **Schema/reference gate** (free): unknown `elementId`, > 10 steps, missing terminal
   assertion, literal credentials where a `{{seed}}` token is required, description
   variant outside its two exemptions.
2. **Graduated safety filter** (free, on intents — action + element accessible name).
   NOT recon's lexicon verbatim (it blocks checkout/save/confirm — the highest-value
   journeys — and its role-based rule would block "check the terms box"). Three-way
   split, defined in `write/write-safety.ts`:
   - **hard-block**: pay, purchase, buy, delete, remove, transfer, publish, send, post,
     deactivate, cancel subscription… → scenario rejected under `safeMode` (default on).
   - **synthetic-safe** (allowed ONLY when the suite's `allow_synthetic_data` consent
     flag is set): register/signup/login/add-to-cart/newsletter-subscribe with per-run
     unique `{{seed}}` data. Without consent: scenario survives WRITE but is
     validation-blocked (§6.2).
   - **stop-before-the-money-step**: checkout-family skeletons navigate TO the payment
     step and assert arrival; they never click the money button (encoded in the catalog
     skeletons, enforced here as a lint on checkout-tagged scenarios).
   - Recon's role-based mutating rule (checkbox/radio/switch) applies to CRAWLING only.
3. **Render + AST-equality invariant** (free): renderer output must round-trip —
   the rendered sentence's re-compile (when it happens on the fallback/human-edit path)
   must equal the constructed AST; enforced in tests via the golden template set.
4. **AST lints** (free; advisory-to-judge, not auto-reject):
   - *delta-assertion*: the final assertion must reference post-action state;
   - *negative-shape*: Tier-1 negatives terminate in a positive rejection-state assertion;
   - *determinism*: no `wait` as the only synchronization, no volatile literals
     (prices/dates/counts), `click_random` only with its capture closing the loop.
5. **Kind-aware dedup** (`write/dedup.ts`): exact SHA-256 of normalized rendered steps
   (byte-identical thanks to canonical rendering) + embedding cosine > 0.92 — compared
   WITHIN kind (or excluding oracle steps), else happy/negative pairs sharing 80% of
   steps get collapsed.
6. **Rubric judge** (`judgeScenarios`, ONE batched mini call per job): 4 dimensions —
   the inversion + lints made the rest structurally guaranteed:
   - D1 **meaningful oracle** (HARD) — the pre-state test: "would every assertion
     already pass on the page as it existed BEFORE the scenario's key action ran?"
     If yes → vacuous → REJECT.
   - D2 **negative sharpness** (HARD) — exactly one invalid condition per negative;
     assert presence-of-rejection, never absence-of-success.
   - D3 **user-intent realism** (SOFT) — a task a real user sets out to do, not
     page-poking ("click each header link and verify it loads" is a crawler's job).
   - D4 **marginal value** (SOFT) — adds coverage the batch/suite doesn't already have.
   Verdicts PROPOSE / REVISE / REJECT; REVISE rides the single repair round;
   per-dimension results go into `generation_jobs.report`. A golden good/bad fixture
   suite tests the judge itself. Judge runs BEFORE validate — browser wall-clock is the
   scarce resource, ~1–2k judge tokens are not.
7. **VALIDATE** (§5) — the universal backstop for ALL sources, catalog and LLM alike.

## 5. Phase 5 — VALIDATE

`validate/validation-runner.ts` (unchanged mechanics from v1):

1. Save surviving scenarios via `src/db/case-writer.ts` with `status='validating'`,
   `origin='generated'`, `generation_job_id`; steps' constructed ASTs stored on
   `test_steps.compiled_ast`.
2. `INSERT INTO runs (triggered_by='testwriter')`, enqueue `RunJobPayload` on the
   existing `kaizen-runs` queue with `seedVariables: generateFormData()` and the stored
   ASTs as `compiledSteps`. Concurrency 2; poll 2s; 5-min timeout per run.
3. Verdicts: positive `passed` → `draft` (+`validation_run_id`); `healed` → draft +
   flagged; `failed` → `rejected` + failing step + run link. Tier-2 per §3.1.
   Consent-blocked synthetic scenarios skip validation and land as
   `draft (unvalidated)` with a badge (UX spec §2.3).
4. Validation runs excluded from customer run lists (`triggered_by <> 'testwriter'`).

### 5.1 Discover oracles — harvest-to-report (no auto-loop)

Description-variant assertions render as generic phrasing ("verify the error message is
visible"). During the validation run the harness **harvests** the observed post-action
state — final URL, top heading, visible alert/toast text — into
`generation_jobs.report.harvest[scenario]`. The reviewer hardens the assertion to the
specific observed text in the draft-review UI (they are reviewing the draft anyway).
The automated judge-confirm + rewrite + re-validate loop is deferred: it would double
worst-case validation browser-minutes.

## 6. Cost, metering & consent

- Pre-flight tenant budget 402 gate (unchanged). Per-job token cap.
- Caps: `maxScenarios` ≤ 10, ≤ 10 steps/scenario, 1 repair round, 2-run validation
  concurrency, 5-min run timeout.
- **Metering fixes shipped with P2**: `generateEmbedding` emits billing events
  (openai.gateway.ts:324 currently emits nothing — also correct
  `docs/known-issues/embedding-tokens-not-tracked.md`, which claims otherwise);
  `tokenUsage` in the report gains `write`, `judge`, and `fallbackCompiles` lines;
  fallback compiles bill the tenant (§3).
- **6.2 Synthetic-data consent**: suites gain `allow_synthetic_data BOOLEAN DEFAULT
  false` (migration 030). Gates VALIDATE execution (and archetype family eligibility)
  for scenarios that create real records (accounts, cart state) — with per-run unique
  `{{seed}}` data when allowed. Consent is recorded on the job row for audit.
- Calibration gate: ONE real dogfood analyze job validates all token/wall-clock
  estimates before any tenant-facing numbers.

## 7. Testing

Unit (mock gateway, mock queue):
- Schema gate: unknown elementId rejected; description variant accepted only via its
  two exemptions; literal email where `{{email}}` required → rejected.
- Renderer: golden template set — every action round-trips (render → compile → equal AST).
- Safety split: "pay now" click blocked; signup allowed only with consent; checkout
  skeleton (stop-before-money) passes; "check the terms box" passes.
- Lints: vacuous-final-assertion flagged; Tier-1 negative without rejection assertion
  flagged; `wait`-only sync flagged.
- Judge golden fixtures: a vacuous test REJECTED, a sharp negative PROPOSED, a
  page-poking scenario flagged on D3.
- Tier-2 verdicts; kind-aware dedup keeps happy/negative pairs.
- Plan-approval: job pauses; resume writes only approved entries; notes reach the
  WRITE prompt.

Live acceptance (P2 exit, `/dogfood` style): see the plan-file verification section —
including: job pauses at `awaiting_plan_approval` and resumes with only the approved
subset; a deliberately vacuous scenario is killed by the JUDGE (not validation);
consent OFF ⇒ signup drafts remain unvalidated; harvest data appears in the report.
