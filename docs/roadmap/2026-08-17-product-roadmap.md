# Kaizen — from MVP to Product (2026-08-17)

> **Status**: Founder-requested navigation document. Reconciles the two existing roadmaps
> (`docs/specs/roadmap/spec-feature-backlog.md`, Aug 4–7, and the assessment 10-step sequence in
> `docs/assessments/2026-08-12-testwriter-full-assessment.md`) into one mission plan, and folds in
> competitive research on QA Wolf (site + full docs), mabl, and Parlant.
> This document says WHAT and WHY and in what ORDER. Each mission still gets its own spec (SDD)
> before code.

---

## 1. Product thesis — what Kaizen is

**Kaizen is an autonomous QA engineer whose word you can trust.**

Every competitor in this space generates tests with AI. The honest difference between them is
*what makes a green checkmark believable*:

- **QA Wolf** makes it believable by putting **humans at every seam** — humans publish the mapped
  flows, review the generated code, triage every failure, and do "unlimited maintenance". Their
  docs describe **no automated quality gates at all**; when a test fails you click "Fix with AI",
  and the protection against the AI quietly weakening the assertion is a human reading the diff.
  That works, and it prices like a service business.
- **mabl** makes it believable with **breadth and analytics** — low-code, coverage dashboards,
  API/accessibility/performance add-ons. It doesn't try to prove a passing test could fail.
- **Kaizen** makes it believable with **machinery**: the oracle audit, the vacuity probe,
  `validation_state`, the sign-in premise check, findings instead of silence. A test only ships
  when the system has evidence the assertion *can* fail and *didn't*. That is the wedge, it is
  already built, and reading QA Wolf's docs end-to-end confirms nobody else has a place in their
  architecture to put it.

Two assets compound behind that wedge:

1. **The living app model** — per-tenant, per-app site knowledge (pages, elements, journeys,
   briefs) that every job deepens and every test grounds itself in.
2. **The trust ledger** — every draft carries its evidence (validation run, oracle audit verdict,
   healing history, cache provenance), machine-checkable end to end.

Positioning in one line: *QA Wolf sells you a QA department; Kaizen sells you a QA engineer that
proves its own work.*

## 2. Where we stand (honest inventory)

**Strong base — built and live-proven:**
- Self-healing executor: NL steps → compiled AST → Playwright, 6-layer resolver
  (archetype → Redis → Postgres → 2× pgvector → LLM), healing chain, `firstRunTokens: 97 →
  lastRunTokens: 0` demonstrated in live data.
- Test Writer pipeline: RECON (safety-gated interactive crawl, authenticated scope with consent
  model, SSRF guard, capture tiers) → COMPREHEND → PLAN (catalog + LLM gap-fill, plan-approval
  checkpoint) → WRITE (structured intents, 7-gate stack) → VALIDATE (real runs, never propose
  unproven).
- Oracle integrity (PRs #68–#70): oracle audit, self-echo/faithfulness/weak-oracle detection,
  vacuity probe, `validation_state` (migration 035), final-state capture, assertion cache/heal
  exclusions. The four false-green production drafts were caught and re-graded by this machinery.
- Findings channel + coverage endpoint (PR #71, open): six finding kinds, ranked, sanitized; a job
  that writes no tests still hands you the bug list.
- Platform: multi-tenant identity/RBAC, API keys, token quotas + billing meter, usage screens,
  native-grade UI shell, CI on the repo.

**The honest gaps, in order of how much they hold the product back:**

| Gap | Reality |
| --- | --- |
| **Built things users cannot reach** | The entire authenticated-scope backend (97 KB spec, live-proven) has **no consent UX** — users cannot use it at all. The Suggest button is dead UI. The writer wait-screen has no progress/live updates. Findings (PR #71) have an API shape but no screen. |
| **Knowledge doesn't compound** | The tenant brief has been used by **0 suites ever**. All 8 App Briefs have `journeys: []`. pgvector embeddings on the site model were **never populated**. Knowledge is keyed by suite, so analyzing a second suite of the same app starts from zero (app-entity spec approved, unbuilt). |
| **Isolation is a promise, not a mechanism** | RLS is **inert** — the runtime role owns every table, `FORCE ROW LEVEL SECURITY` nowhere. Tenant isolation currently rests entirely on query discipline. Confidentiality is our stated #1 priority; this is the gap between saying it and having it. |
| **No loop after delivery** | No MAINTAIN, no notifications (worker still constructs `LogNotifier`), no quarantine for known-broken tests, findings die with the job report. |
| **Depth ceiling** | RECON never submits forms → post-submit states, multi-page journeys, and data lifecycle are invisible. No `assert_count` in WRITE (engine has it). Catalog is e-commerce-shaped. |

## 3. What the competitor research actually taught us

### QA Wolf (site + complete docs read)
Same pipeline shape as ours (Map ≈ RECON+COMPREHEND, Automate ≈ PLAN+WRITE, Run ≈ VALIDATE), then
a fourth stage we lack: **Triage as a lifecycle**. Steal, in priority order:

1. **Bug report vs maintenance report as first-class objects.** A failure is either the app's
   fault (bug report — multiple flows link to it, **auto-closes when all linked flows pass**) or
   the test's fault (maintenance report — filing it **quarantines** the flow so it stops polluting
   runs). We built the detection half (`possible_app_defect`); we have neither the lifecycle nor
   quarantine.
2. **SKILL.md — persistent per-app knowledge files** (frontmatter + markdown: domain vocabulary,
   environment quirks, team conventions), **auto-loaded into every AI session** including mapping.
   Their framing: "Good skill content is anything you would otherwise repeat across many prompts."
   This is a strictly better version of our dead tenant brief.
3. **Interactive mapping.** Their agent asks for credentials *in chat* when it hits a login and
   accepts steering while it works. Our RECON is fire-and-forget — which is exactly why our
   dogfood died silently when sign-in failed.
4. **A durable, published coverage map** with per-case status *and the reason for any rejection* —
   accumulated across runs, not one-shot per job.

### mabl
Coverage analytics as a selling surface, and breadth (API/a11y/perf) as tier-2 add-ons. Lesson:
our coverage endpoint should grow into a screen a QA lead opens weekly, not stay a JSON route.
Anti-lesson: do not chase their breadth now (see §6).

### Parlant (github.com/emcie-co/parlant)
Python-only, server-based — **not a dependency for us**. But it is the best-articulated answer to
a problem we are about to hit hard: *"the more instructions you add to a prompt, the faster your
agent stops paying attention to any of them."* Their answer is **context engineering** — knowledge
stored as many small **condition → action guidelines**, with the engine matching only the relevant
ones into each LLM call, plus **journeys** as adaptive multi-step SOPs, and full auditability of
which guideline influenced which decision.

Applied to Kaizen: app knowledge (Mission 3) must NOT be one growing blob of brief text stuffed
into every prompt. It should be **scoped knowledge entries** (per-app, optionally scoped to a
page/journey/archetype: "the cookie banner must be dismissed before anything", "use test card
4242…", "admin role sees /settings") that RECON/PLAN/WRITE **selectively load by relevance**, with
per-scenario provenance recording which entries were used. That is Parlant's architecture,
re-implemented in our stack at the size we need.

## 4. The missions

Continuity note: steps 1–5 of the accepted 10-step sequence are DONE (PRs #68–#71). The missions
below carry the remaining steps (6–10) and layer the product surface + competitor learnings on
top. Order within a mission is negotiable; the mission order is the recommendation.

---

### Mission 1 — Make what's built reachable (the product surface)
*"We have a warehouse of working backend that no user can touch."*

**Ships:**
- **Consent UX for authenticated scope** (spec-authenticated-scope §11) — login-recipe picker,
  consent capture, scope selector on the analyze dialog. Unlocks the single most valuable built
  feature; every real app's value is behind login.
- **Writer progress screen** — live phase/counters from `report.progress` (agreed with founder
  weeks ago, never built). The analyze wait is currently a blank stare.
- **Findings on screen** — render `report.findings` ranked, with evidence links; the "even a job
  with zero tests hands you a bug list" moment must be visible to be worth anything.
- **Wire the Suggest button** (`POST /suites/:suiteId/suggest`) — scoped generation against
  existing knowledge; the button has been dead UI since April.
- Plan-approval screen polish: show `outline`, deselection provenance.

**Why first:** highest ratio of product delivered per unit of work in the whole plan — the backend
for all of it already exists and is tested. This mission is the difference between "impressive
repo" and "usable product".

**Done when:** a new user can run an authenticated analyze end-to-end from the UI — consent,
progress, plan approval, findings, draft review — without touching an API client.

> **Amended 2026-08-17, after a code audit at the start of the mission.** The bullets above were
> reconciled from two older roadmaps and inherited stale claims in both directions. The corrected
> inventory, which the specs now carry:
>
> - **Consent UX** — as described. Backend complete, UI is one disabled row. Unchanged.
> - **Writer progress screen** — *already built* (`6e99583`). `ProgressFace` polls at 2s and
>   renders real counts from `report.progress`, which the pipeline writes. What is actually
>   missing is smaller and different: the `plan` phase never writes progress (so that segment of
>   the rail never lights), and the away-from-screen channel the copy promises — tab title,
>   sidebar chip, transition toasts — does not exist. Specced at
>   `docs/specs/tests-ux/spec-testwriter-ux.md` §11.6.
> - **Findings on screen** — *already built* (`3e56294`), including the zero-draft case. Missing:
>   findings are dropped on the blocked/halted face, which is the one place §0's "a job must never
>   return nothing" rule matters most; two of four evidence fields never render; and
>   `GET /suites/:id/coverage` — complete, honest, thin-crawl-guarded — has no UI at all.
> - **Suggest** — the backend does **not** exist. There is no route and no scoped pipeline mode;
>   the dead button sits in the dormant component tree. This is a small feature, not a wiring job.
>   New spec: `docs/specs/test-writer/spec-scoped-suggest.md`.
> - **Plan polish** — `outline` is already rendered per row. Deselection is still unrecorded.
>
> Net effect on the mission: unchanged in value and slightly smaller in total, with the work
> redistributed — deliverables 2 and 3 shrink to finishing touches, deliverable 4 grows into the
> second-largest piece after consent. §2's gap table above is stale for the same reason; trust
> `spec-testwriter-ux.md` §0.0, which is a maintained audit.

---

### Mission 2 — Trust foundation: app-entity + real RLS
*"Confidentiality is priority #1 and knowledge should survive the suite."*

**Ships:**
- **Migrations 036/037 app-entity** (spec approved 2026-08-12): re-key site knowledge from
  `(tenant, suite)` to `(tenant, app)`; `apps` + `app_origins`; sticky `suite.app_id`; 409
  APP_MISMATCH. Two suites pointing at the same app now share and deepen one model — the founder's
  own ask ("data must not be gone when I analyze another website") and the moat's substrate.
- **FORCE ROW LEVEL SECURITY** across tenant tables + the non-owner runtime role question settled.
  Turns tenant isolation from query discipline into a database guarantee. The enterprise
  security-review answer ("your data cannot leak to another tenant") becomes an architecture fact.
- Seed of P6 governance: tenant-offboarding purge path (one command, verifiable) — cheap now,
  brutal to retrofit.

**Why second:** Mission 3 makes knowledge *bigger and more valuable*; it must land on correct
keying and enforced isolation, not be migrated later. And selling to anyone serious requires the
RLS answer.

**Done when:** two suites on one app share one site model; a cross-tenant query under the runtime
role returns zero rows *by database enforcement*; offboarding purge is demonstrated on a dev
tenant.

---

### Mission 3 — Compounding app knowledge (SKILL.md × Parlant guidelines)
*"The test writer should hold expert knowledge of the app, like a senior QA who's been on the
account for a year."*

**Ships:**
- **App knowledge entries** replace the dead tenant brief: small, structured, per-app records —
  vocabulary, environment quirks, conventions, credentials-adjacent facts (never secrets),
  condition→action guidelines — editable in the UI, versioned, **auto-loaded into RECON, PLAN,
  and WRITE by relevance scope** (Parlant's context engineering, our stack). Provenance: each
  scenario records which entries shaped it.
- **Self-writing knowledge:** each job distills what it learned (harvested post-submit states,
  healing outcomes, resolver pain points, "this app's search is at /s?q=") into *proposed* entries
  the user approves — the QA engineer taking notes.
- **Journeys become real:** populate site-model embeddings, make COMPREHEND emit journeys as
  ordered page paths again (all 8 briefs currently say `journeys: []`), stored on the app entity.
- **Interactive analyze (v1 cut):** when RECON hits a login wall or a blocking unknown, the job
  pauses in a `needs_input` state and asks a concrete question in the UI instead of failing 90
  seconds later — QA Wolf's chat-mapping, reduced to our job model.

**Why third:** this is the founder's stated end-goal ("knowledge about the system as an expert
QA") and the retention moat — every week a tenant uses Kaizen, their model gets deeper and
switching gets costlier. It needs Missions 1–2 (a reachable surface, correct keying).

**Done when:** a re-analyze of a known app demonstrably uses prior knowledge (fewer tokens, plan
references known journeys, entries cited in provenance), and a paused job has been steered to
completion through the UI.

---

### Mission 4 — The triage loop (QA Wolf's fourth stage)
*"A failure becomes a workflow object, not a log line."*

**Ships:**
- **Persistent findings with lifecycle:** findings graduate from job-report JSON to rows with
  state. `possible_app_defect` → an open **bug record**, linked to the case(s) that evidence it,
  **auto-closing when all linked cases pass again** (QA Wolf's elegant trick — the bug list stays
  true with zero grooming).
- **Maintenance split + quarantine:** a failure diagnosed as the *test's* fault (selector rot the
  healer couldn't fix, changed flow) files a maintenance record and **quarantines** the case —
  excluded from scheduled runs, prominently parked for repair. Today a known-broken test fails
  forever and poisons every suite run.
- **Pillar B notifications** (spec-run-notifications, renumber its migration past 037): webhook +
  Slack on `run.failed`, `finding.opened`, `job.completed` — the loop's delivery mechanism.
  Payloads carry failing step, failure class, screenshot link, deep link.

**Why fourth:** it converts Kaizen from "generates and runs tests" to "runs your QA function".
Requires findings (shipped, PR #71) and benefits from app-entity linkage (Mission 2).

**Done when:** a real app defect opens a bug record, Slack pings, the record auto-closes when the
app is fixed; a broken test is quarantined and its suite goes green around it.

---

### Mission 5 — Depth: journeys, data lifecycle, sharper oracles
*"Test like a senior QA tests, not like a crawler that learned to write."*

The remaining accepted roadmap (steps 7–9), unchanged in substance:
- **RECON form-submit tier** (consent-gated, synthetic-safe) → post-submit states become visible →
  **multi-page journey scenarios** → **test-data lifecycle** (create-then-delete with teardown;
  currently "the bomb is armed": creation exists, teardown is safety-forbidden).
- **`assert_count` in WRITE** + boundary/equivalence archetypes (engine support already shipped —
  do NOT rebuild it; only the WRITE union + catalog entries are missing).
- **SaaS/CRUD archetype expansion** + thin-crawl conditioning + the cross-job dedup fix.
- Vacuity probe live verification against a resolver-friendly target (unit-proven only today).

**Done when:** Kaizen writes a green multi-page journey (signup → create thing → verify → clean
up) on a demo SaaS app, with a quantitative oracle in it, and the data it created is gone
afterwards.

---

### Mission 6 — MAINTAIN + the published coverage map
*"The living model stays aligned with the app, and coverage is a page, not a route."*

- Scheduled re-crawl (finally implements the `schedule` trigger + `src/jobs/`), `content_hash`
  diff → staleness flags on affected tests, new-page plan proposals. Minimal cut first:
  login-prefix staleness flagger (step 10 of the accepted sequence).
- **Coverage map as a durable screen** (mabl's lesson + QA Wolf's published map): pages ⋈ tests ⋈
  findings, accumulated across jobs, with per-gap reasons ("described in knowledge but never
  observed — behind auth?"). `coverageConfidence` already models the honesty; give it a face.

**Done when:** a page change on a monitored app produces a staleness flag and a proposed plan
entry without anyone clicking analyze; the coverage screen answers "what is not tested and why"
at a glance.

---

## 5. Sequencing and rhythm

```
M1 product surface  ──►  M2 app-entity + RLS  ──►  M3 knowledge  ──►  M5 depth
                                   │                     │
                                   └────►  M4 triage loop ┘         M6 maintain (after M3, parallel to M5)
```

- M1 is pure frontend/UX over existing backend — it can start immediately and does not conflict
  with anything.
- M2 before M3 (keying + isolation before the data grows). M4 can overlap M3 (different files).
- Each mission = its own spec(s) first, PRs in the established granularity (small, reviewed,
  each independently shippable), live dogfood in the exit criteria — the discipline that caught
  the false-greens stays.

## 6. What we deliberately do NOT build now

Carried from the quality audit, re-affirmed by the competitive read:

- **Breadth-chasing** — mobile devices, camera/audio injection, VPN, Electron, visual diffing,
  a11y/perf suites (QA Wolf/mabl territory). Their breadth is decades of accretion; matching it
  is unwinnable and off-thesis. We win on trust-per-test, not surface area.
- **Human-services layer** — QA Wolf's premium tier is staffed humans; our answer is the trust
  machinery, not hiring.
- **Full CI integration (B11)** — designed (spec-ci-integration), parked until the triage loop
  exists; a CI gate without quarantine amplifies noise.
- **Standalone security scanner, requirement traceability, wider scenario budgets, more judge
  prompt-hardening** — audit's "not yet" list stands.
- **`scenario_archetypes` table / learned-archetype telemetry** — still awaiting fleet volume.
- **BYO LLM key, marketplace/integrations beyond Slack+webhook** — enterprise-tier work for when
  there is an enterprise conversation.

## 7. Doc hygiene (small, do alongside M1)

The docs survey found drift that will misdirect future agents:
- Stale "implementation not started" headers on `spec-recon-crawler.md`,
  `spec-comprehension-knowledge-model.md`, `spec-generation-pipeline.md` (all substantially built).
- `spec-run-notifications.md` migration number must move past 037.
- Assessments say "035 = app-entity"; `spec-app-entity.md` renumbered it to 036/037 — the newer
  spec is authoritative.
- Superseded banners missing on `kaizen-spec-v1/v2.md`, `spec-prototype-port.md`.
- No summary card exists for `src/modules/test-writer/` — the largest active subsystem.
- This document supersedes neither existing roadmap; it *sequences* them. The feature backlog's
  B6–B10 (evidence UX) slot naturally into M1/M4; B11 stays parked (§6); B12 lands in M6.
