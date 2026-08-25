# Spec: The Agentic Test-Writer — from pipeline to orchestrated agents

**Created:** 2026-08-23
**Updated:** 2026-08-23 — Stages 1–3 implemented (§5.1); A's graded rerun cancelled by the founder
(§1.1); volume bar for acceptance: ≥ 226 delivered tests in one memoryless run (A's count).
**Status:** In progress (founder direction 2026-08-23: "we should implement exactly what A and/or B
did... it is not possible that test-writer can only create 10 tests costing the same or even more
tokens"; and: no commit until the writer itself delivers A-level volume)
**Owner:** test-writer
**Companions:** spec-close-the-gap-32.md (the 25-run campaign this supersedes the SHAPE of, while
keeping every lesson), the A/B experiment artifacts in benchmarks/claude-qa/

---

## 1. The experiment that forced this

Two Claude (Opus 5) agents, no shared history, were asked to test Kaizen's dashboard as a senior
QA would (2026-08-21):

| | A — black-box | B — white-box (code + browser) | Kaizen pipeline (run 25) |
|---|---|---|---|
| Tests written | 226 | 526 | 20 (11 proposed) |
| Graded result | (env-degraded run; final numbers in §1.1) | 486 pass / 13 fail / 27 skip (92%) | 7 proven, 7/7 fidelity |
| Knowledge doc | 28KB | 64KB | element inventory + classifications |
| Real bugs found | 4 (suite-name discard, false demo copy, CSS-case trap, sidebar localStorage leak) | 6+ (scope-mixed stats card, false demo-safety, 3 dead controls, dead routes) | 3 across runs 19–25 (double-Cancel, no-steps save, NAVIGATE field) |
| Tokens | ~350–450k (est; exact lost) | 415,212 | 226,884 |

Granularity discount: an agent "test" is one fact; a pipeline scenario is a journey. B's 526 ≈
70–80 journey-equivalents. The honest gap is therefore ~7x output at comparable cost — structural,
not stylistic.

### 1.1 A's graded run

CANCELLED by the founder (2026-08-23) at 183/218 with the environment degraded a second time —
"we dont need it no more": the pivot decision no longer depends on A's exact pass rate. A's 226
WRITTEN tests stand as the volume bar.

## 2. Why the pipeline loses 7x

1. **Batch factory vs agent loop.** The agents iterate: helper → run → real error → fix helper →
   every later test inherits it (A's case-insensitive matcher; B's storageState). The pipeline
   writes each scenario in one isolated LLM call; nothing shared evolves. Every scenario re-pays
   for the app's traps.
2. **No calibrate-then-transcribe phase split.** A spent 40 min debugging 19 calibration tests,
   then transcribed 170 in 8 minutes. The pipeline treats every scenario as equally expensive.
3. **Verification granularity.** B verified ~50 facts per browser session (one setup, many
   assertions). The pipeline spends a full engine run (~1–2 min) per scenario. Batch verification
   amortizes 10–50x.
4. **Deliberate volume suppression** tuned for the old cost model: maxScenarios 30, perPage 3,
   judge "marginal value" pruning, dedup.

## 3. What carries over unchanged (the moat)

Both agents independently reinvented the campaign's oracle discipline — presence-before-absence,
own-fixtures-only, close-means-the-surface-disappears, no volatile counts, empty-state literals.
These stay, as the calibrator's instincts and the reviewer's checklist:

- All write HARD RULES (gateway), the schema/judge/safety gates, the contradiction and echo gates.
- Validation-trust semantics: nothing is called PROVEN without an engine-verified run.
- Findings (a11y, duplicate names, possible_app_defect) — the agents produced these too; keep the
  channel.
- Memoryless mandate: each analyze starts from the crawl + brief + its own run only.
- NL steps as the product's test format — self-healing and non-engineer editability are why
  Kaizen exists. The agents wrote raw Playwright; we write NL compiled to AST. The format is NOT
  the bottleneck; the generation shape is.

## 4. The new shape

Orchestrator + subagents with message passing (the same pattern the founder ran on 2026-08-21:
main coordinating A and B, relaying constraints mid-flight, pinging for status).

One explorer, two MODES — not two agents (founder decision 2026-08-23). Code access is an input
condition on exploration, not an architecture fork. The explorer's contract is mode-independent:
produce APP-KNOWLEDGE as VERIFIED CLAIMS. In black-box mode every claim is earned by probing the
live app. In white-box mode the code is read first into a claim list, and every claim is verified
live before it enters the artifact (code facts are hypotheses — the A/B experiment's white-box
agent had its own routing claim disproven by the live check). White-box mode additionally emits
the code-vs-live DISAGREEMENT channel (a bug-detector black-box cannot have). Partial access
(frontend only, API docs only) is the same design with fewer claims. Downstream stages never know
which mode fed them.

```
ORCHESTRATOR (persistent, owns the budget and the knowledge artifact)
 ├─ EXPLORER  (browser agent, mode: blackbox | whitebox(repo) — produces APP-KNOWLEDGE:
 │             screens, controls, exact strings, behaviors, quirks, auth/session lifecycle —
 │             iterative probes, not one pass; whitebox verifies code-derived claims live)
 ├─ CALIBRATOR (writes ~10–15 representative journey scenarios in NL, validates each through
 │             the ENGINE, converts every failure into a SUITE CONVENTION — the traps ledger)
 ├─ TRANSCRIBERS (fan-out; mass-produce granular NL tests per screen/capability, reusing
 │             proven interaction patterns from the conventions ledger; never invent new
 │             interaction shapes — those go back to the calibrator)
 └─ VERIFIERS (batch: many facts per browser session for the granular tier; full engine runs
               reserved for the journey tier and a random audit sample of the granular tier)
```

Tiers in the delivered suite:
- **Journey tier** — engine-validated, self-healing, PROVEN label. Today's pipeline quality bar.
- **Fact tier** — granular checks batch-verified (grouped sessions), labeled VERIFIED-BATCH.
  A random ≥10% sample also goes through full engine runs each analyze; a sample failure quarantines
  the batch.
- Anything unverified ships only as DRAFT with its reason.

Targets at today's budget (~250–400k tokens/analyze): 100–300 delivered tests, of which 10–20
journey-proven; wall-clock ≤ 90 min.

## 5. Staged implementation

1. **Stage 0 (measurement):** ~~re-grade A~~ cancelled (§1.1); A's written count (226) is the bar.
2. **Stage 1 (conventions ledger):** add the calibrator's failure→convention loop to the CURRENT
   pipeline (in-run only, memoryless-compliant). Cheap, immediate.
3. **Stage 2 (batch verifier):** verify granular assertions many-per-session; introduce the fact
   tier and the audit sample.
4. **Stage 3 (transcriber fan-out):** per-screen mass generation from the knowledge artifact +
   conventions; lift the volume caps.
5. **Stage 4 (orchestrator):** replace the fixed DAG with the agent loop; subagent messaging,
   status pings, mid-flight constraint injection (the founder-relay pattern).

### 5.1 Stages 1–3 as implemented (2026-08-23)

The journey rounds ARE the calibration phase; what they pay to learn feeds the fact tier:

- **Conventions ledger** (`transcribe/fact-transcriber.ts` `buildConventions`): the rounds'
  per-page lesson map plus content-bearing validation/judge rejections, deduped, capped at 12
  lines, built fresh each run — memoryless by construction. Rides into every transcriber call.
- **Transcriber** (`ITestWriterGateway.transcribeFactTests`, one FRONTIER call per screen):
  returns many granular facts in the WRITE intent grammar under a stricter contract — element-id
  targets ONLY (no descriptions, no click_random, no navigate), ≤ 5 steps, assertion-terminated,
  read-only vocabulary, exact-text oracles from supplied material. `runFactGate` enforces all of
  it deterministically, plus role compatibility, the echo trap, the new-tab trap, and the
  contradictory-asserts rule. The WRITE safety lexicon runs on every fact with consent forced
  false: the fact tier promised to be read-only.
- **Batch verifier** (`transcribe/fact-verifier.ts`): ONE browser session (crawler's pool +
  sign-in machinery) replays every fact against recon's recorded selectors — selector first,
  role+name (live counts stripped) fallback — with dialogs dismissed, navigation origin-guarded,
  one re-sign-in per batch. No model calls, no engine runs: ~300 facts in minutes.
- **Audit sample:** min(8, 10%) of the verified facts — interactive first — re-proven by the REAL
  engine via the ordinary ValidationRunner (vacuity probes included). >50% audit failure sets
  `quarantineAdvised` on the report. Sampled facts deliver under the engine's own labels.
- **Honest label:** batch-verified facts land as drafts with `validation_state = 'verified_batch'`
  (migration 043) — never 'validated', which still means an engine proof.
- **Plumbing:** `options.factTier` (opt-in) + `options.factsPerPage` (default 25, cap 40) on the
  analyze API and the job payload; progress phases `transcribe`/`fact_verify`; report block
  `report.facts` {pages, transcribed, rejectedAtGate, verified, failedVerify, delivered,
  auditSample, auditDelivered, auditFailed, quarantineAdvised, error}; bench `--facts N` flag.
  A fact-tier crash never fails the job — the journey results stand (`report.facts.error`).

## 6. Open questions

- Engine throughput for the audit sample (runs are ~1–2 min; sampling 20 of 200 ≈ 40 min — may
  need worker parallelism).
- Fact-tier persistence shape: same test_cases rows with a tier column vs separate table.
- How the UI presents 300 tests without burying the 15 proven journeys (delivery tiers, §spec-
  findings-and-coverage).
