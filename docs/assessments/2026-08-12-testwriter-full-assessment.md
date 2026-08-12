# The Test Writer vs. a Senior QA Engineer — Full Assessment

**Date:** 2026-08-12 · **Method:** three multi-agent research workflows (31 agents total) — a plan-vs-built audit (95 commitments checked against code and the live DB), a quality audit of the actual generated tests (5 assessment lenses, every critical/major finding adversarially verified: **39 confirmed, 0 refuted**), and a data-architecture design competition (3 designs, 2 judges, 10-attack adversarial pass). Companion documents: [plan-vs-built ledger](2026-08-11-plan-vs-built-ledger.md) · [app-entity architecture plan](2026-08-11-app-entity-architecture-plan.md).

---

## Verdict

The bar is not "a good test generator." The product thesis is that the Test Writer **is** a senior QA engineer: it holds expert knowledge of the system under test, and it plans and writes tests at that level.

Measured against that bar honestly: **the engine's discipline is senior-grade; its knowledge, its oracles, and its deliverables are not yet.** The defensive machinery genuinely works — grounding gates reject hallucinated elements, the judge rejected 8 weak sibling scenarios, safety lexicons held under authenticated scope, and its restraint (knowing what *not* to automate) is the one capability that is fully at the expert level today. But the trust seal is broken where it matters most: **all four validated-green drafts from the live dogfood carry oracles that cannot fail**, and the selection pressure is inverted — the only sharp oracle ever generated failed honestly and was rejected, while the vacuous ones sailed through. A senior QA would sign today's output as a well-validated smoke layer, not as coverage, and not yet as a colleague.

The good news buried in that sentence: the fixes for the trust seal are mostly **small and deterministic** — SQL audits and schema-gate checks, not new ML. The expensive-looking problem is cheap; the cheap-looking problem (what the product *delivers* on a bad day) is the real strategic gap.

---

## Stage by stage: the expert vs. the system

### 1. Knowledge of the system

**The expert:** builds a mental model of what the app is *for* — its core entities, its money paths, what a user is trying to accomplish, which corners are risky. Reads the docs. Asks the team.

**The Test Writer:** on Kaizen itself — exactly the SaaS class customers will bring — it built a **1-page, 0-link, 0-journey world model**. All 8 App Brief versions in the dogfood DB have `journeys: []`. The one input designed to carry expert context — the tenant brief, where a human describes the app — has been used by **0 of 24 suites in the life of the database**. The comprehension architecture is defensively sound (graph-verified journeys, deterministic normalization, scope steering all demonstrably fired), but on a thin crawl it confidently knows almost nothing and does not say so.

**The delta:** the knowledge exists but is imprisoned — by suite keying (fixed by the app-entity plan), by SPA-invisible navigation (known issue), by recon never submitting forms (every post-submit page is invisible), and by nothing ever *consuming* stored entities. And the system does not yet know what it doesn't know: no thin-crawl disclosure reaches the human.

### 2. Test planning

**The expert:** triages by risk — money paths, data loss, auth — and scales ambition to evidence. On a system they barely explored, they say so and plan narrowly.

**The Test Writer:** filled its full scenario budget (5/5, 5/5, 4/4) **three consecutive times from the 1-page model**, planning against settings/analyses pages it never observed. The 31-archetype catalog is e-commerce-shaped, so on Kaizen it could only contribute `search.*` and one forms negative; the LLM gap-fill reservation — the mechanism meant to cover app-specific flows — went **0-for-6, and has produced zero validated tests anywhere, in any scope**. Risk triage did happen in the dogfood — but a **human** did it, discarding 4 of 5 planned scenarios at the approval checkpoint.

**The delta:** the planner prioritizes by archetype defaults and page enumeration, not risk. Missing: a SaaS/CRUD archetype family, evidence-scaled budgets, a thin-crawl banner at the approval screen, and the tenant brief actually being solicited (the consent UX work makes this natural).

### 3. Writing tests

**The expert:** writes multi-page stateful journeys (create → open → edit; cart → checkout → confirm), manages test data lifecycle (unique values, cleanup), probes boundaries, asserts on counts and state transitions.

**The Test Writer:** every surviving test is a **≤4-action, single-page, read-only interaction**. This is structural, not a prompting gap: recon never submits forms, so post-submit pages never enter the site model; targets must cite observed elements, so journeys are inexpressible. The one journey test ever generated failed by construction (it guessed a carousel button for a page hop — journeys carry no element annotations). No teardown concept exists; `delete`/`remove` are hard-blocked by the safety lexicon, so once synthetic-data consent is on, validation runs will accumulate records in the customer's account forever. No quantitative oracles — although `assert_count` is **fully implemented engine-side**; the spec line claiming an engine gap is stale, and only the WRITE union and templates are missing.

**The delta:** the biggest single unlock is a consent-gated form-submit tier in RECON (large), but several sharp upgrades are small: `assert_count` in WRITE, boundary-value archetypes, run-unique creation tokens.

### 4. Proving

**The expert:** a test is proven when its oracle would fail if the feature broke.

**The Test Writer:** green currently means "the resolver found *some* element for every step and nothing threw" — against a cache the pipeline itself pre-warmed. Verified in the live DB:

- 3 drafts assert a "no-results message" / "results header" that resolved to **the always-visible File menu button**.
- 1 draft types `{{firstName}}` into search, then "verifies" that text is visible — which resolved to **the search input it had just typed into**. The engine deliberately scans input values, so this can never fail.
- The wrong anchors were then **cached at confidence 1.0** into `selector_cache`, becoming sticky tenant infrastructure that later runs replayed.
- The signed-in premise of every authenticated validation is itself unproven: the prefix's "verify Tests is visible" resolved via cache to the search textbox, and healing events show it healed **from the login page's email field** — meaning "signed in" could verify while still on the login page.
- Selection inversion, the most damning shape: `assert_url "/prod.html"` — the one falsifiable oracle — failed honestly and was rejected. Vacuous oracles pass. **The gate stack currently selects *for* unfalsifiable tests.**
- The spec's own §14.1 flagship example ("verify the results or no-results header is visible") is true by construction — a disjunction over complementary states.

**The delta:** "proven" must mean three things — every action hit its grounded element, the terminal oracle is discriminating (not satisfied by the test's own input, anchored on an element consistent with its description), and the verdict is stable cache-cold. ~80% of that is a **zero-browser-minute SQL audit** over data already in `step_results`.

### 5. Delivering

**The expert:** on a day when no tests survive, still delivers the most valuable artifact: a findings memo — "your signup page has 5 unlabeled buttons, this page 500s, your auth partition is unverified."

**The Test Writer:** job `4b4a34e7` spent 11,020 tokens, proposed zero tests, and **the customer received literally nothing** — while the pipeline internally held judge rejection reasons, auth statistics, `publicPartitionUnverified: true`, and a site model containing 5 icon-only buttons with empty accessible names (a real accessibility defect in the app under test, stored as junk grounding rows). Broken pages during crawl are a warn-log and a `continue`; no counter, no report. Worst verified case: if the XSS-probe test had gone red because the app was actually vulnerable, the red run would be read as "the generated test is wrong" and rejected — **Kaizen would find an XSS and report the opposite.**

**The delta:** a findings channel — a `findings` section in the job report + UI. Nearly all the raw material is already collected or one small hook away. This is the highest-leverage product gap in the entire assessment: it converts every job, including zero-test jobs, into a deliverable a customer would pay for, and it is days of work, not weeks.

### 6. Maintaining

**The expert:** re-tests after changes, flags stale tests, watches coverage drift.

**The Test Writer:** MAINTAIN is not started (an empty `src/jobs/`, a type-level `'schedule'` trigger nothing sets). The coverage endpoint — designed as a single JOIN — was never built. One urgent slice can't wait for the rest: P3 copy-fossilizes the login prefix into every authenticated draft, so **one login-page change silently breaks every authenticated test with no flagger existing**.

---

## Broken now — the eight verified defects

All adversarially verified against the live DB and code; none refuted. Ordered by how directly each produces false confidence. (Full evidence with file:line citations in the appendix roadmap.)

| # | Defect | Fix | Effort |
|---|--------|-----|--------|
| 1 | Green validation certifies element-resolution, not oracle truth — 4/4 promoted drafts unfalsifiable | Deterministic post-run oracle audit (SQL over `step_results`: self-echo, description-faithfulness, LLM-resolved terminal asserts) + executed vacuity probe | S + M |
| 2 | Self-echo & disjunction oracles pass every gate; spec §14.1 example is itself vacuous | Schema-gate lints: typed-value assert rejection, or/either rejection, tautological `assert_url` tracking; fix delta lint scoped to last navigate | S |
| 3 | Wrong anchors become sticky: cached at confidence 1.0, heal-eligible onto different elements | Never cache assert-step resolutions in testwriter runs; asserts ineligible for resolve-and-retry healing; reconcile stale spec | S |
| 4 | Sign-in premise unproven — prefix heal bypasses the did-signin-work check | Include prefix in the audit; login terminal assert must target a signed-in-only element | S |
| 5 | Evidence levels collapsed: healed / clean / consent-held / signin-unproven all read "draft"; healed shows as PROVEN in UI | `validation_state` enum column written at the four existing UPDATE sites; surface in review UI | S |
| 6 | Tier-2 expected-fail accepts *any* failure anywhere; no flake policy | Accept only failure at `prefix.length + failStepIndex` with assertion-class error; one retry before reject; `expected_outcome` on case | S |
| 7 | Known-entity scenarios bind to random seeds ('Taylor') — validation proves one random roll | Schema-gate: find-known-entity queries must be crawl-derived literals; persist validated seed snapshot; full entity source rides migration 035 | S |
| 8 | Cross-job dedup prefix-diluted — byte-identical tests accumulated 8 minutes apart | Strip login prefix before fingerprinting; plan-time dedup on archetype_key + targetPages | S |

Seven of eight are small. **The entire false-green production line stops with items 1–2**, which are pure determinism — no LLM, no browser minutes.

---

## Plan vs. built — the scoreboard

**54 built · 6 partial · 21 missing · 7 explicitly deferred · 7 diverged** across 95 audited commitments. ([Full ledger.](2026-08-11-plan-vs-built-ledger.md))

- **RECON → VALIDATE:** near-complete and evidence-backed. The core pipeline honestly exists.
- **P3 authenticated scope:** backend complete and live-proven — but the §11 consent UX and login-test picker endpoint don't exist, so **users cannot reach the feature at all**.
- **Pillar B (notifications), P5 (MAINTAIN), P6 (data governance): not started.** The "full QA engineer" currently stands on the writing leg only.
- **pgvector embeddings were never populated anywhere** — dedup silently became lexical Jaccard (unrecorded divergence); the vector columns and indexes are dead weight pending a decision.
- **Expired deferrals:** `assert_count` catalog entries (engine gap closed) and authenticated-scope archetypes (P3 done).
- Suggest button: still dead UI wired to a route that doesn't exist.

## Architecture — where knowledge will live

The design competition was unanimous: **the app-entity model** ([full plan](2026-08-11-app-entity-architecture-plan.md)). Knowledge re-keys from `(tenant, suite)` to `(tenant, app)`; an `apps` row owns its set of origins (`app_origins` — the same table B11 needs for preview-deploy aliases); suites keep owning tests and gain a sticky `app_id`; analyzing a different site into a bound suite becomes an explicit 409 instead of silent knowledge-mixing; a second suite pointed at the same app reuses the entire classification cache. Migration 035 (additive + backfill, safe on live prod) then a 036 cutover. Ten adversarial attacks, all resolved in the plan; five open decisions listed at the end of the plan doc.

Two security findings came out of the attack pass, one **confirmed live**:

1. **RLS is inert.** The runtime role owns every table and no table sets `FORCE ROW LEVEL SECURITY` — verified on the dev DB (`relforcerowsecurity = f` everywhere). Tenant isolation currently rests solely on query discipline. One line per table, riding migration 035.
2. A public analyze can erase the tenant's paid-for authenticated knowledge (merge-only stub captures fix it, in the plan).

---

## The sequence

Synthesized across all three tracks. Steps 1–5 are the "stop lying, start delivering" arc; 6–10 build toward the expert.

1. **Oracle audit + schema-gate lints** (defects 1, 2, 4) — stops the false-green line today; everything else assumes greens can be trusted.
2. **Assert cache/heal exclusions + `validation_state` + Tier-2/flake policy** (defects 3, 5, 6) — honest evidence levels; wrong anchors stop becoming infrastructure.
3. **Worker-side final-state capture** (final URL, heading, alert text, console errors, 4xx/5xx) — one capture that feeds the vacuity probe, the never-fired harvest ladder, and findings.
4. **The findings channel** — job report + UI. Converts zero-test jobs into paid-for deliverables; gives red runs a "possible app defect" exit instead of silent self-blame. The single highest-leverage product change in this report.
5. **Coverage endpoint** — already designed, one JOIN; pairs with findings so every report is customer-worthy even at low draft counts.
6. **Migration 035 (app-entity re-keying + FORCE RLS)** — before the features that consume it.
7. **SaaS/CRUD archetype family + thin-crawl plan conditioning + dedup fix** — keyed off 035's entities; fixes the catalog collapse on the exact app class customers bring.
8. **`assert_count` in WRITE + boundary archetypes** — sharp oracles, cheap (engine half exists).
9. **RECON form-submit tier → journey grounding → data lifecycle** — the large unlock for stateful suites; sequenced after oracle integrity because journey tests with vacuous oracles would be worse than none.
10. **MAINTAIN minimal cut (login-prefix staleness flagger), then Pillar B notifications** as the findings delivery pipe.

**Also pending, outside this sequence:** the §11 consent UX (P3 is invisible to users without it — natural place to also start soliciting tenant briefs), and the writer-screen progress UI (already agreed; backend `report.progress` exists and the UI discards it).

**Deliberately not now:** full MAINTAIN/CI (fleet too small to be worth maintaining), a standalone security scanner (ride findings instead), requirement traceability (no brief corpus exists yet), more judge prompt-hardening as primary oracle defense (deterministic gates are the backstop), wider scenario budgets (volume under inverted selection pressure enriches the proposed set with more unfalsifiable tests).

## Decisions that are yours

From the architecture plan (details + recommendations in the plan doc):

1. Hard 409 on second-app-into-suite, or allow multi-app suites? **Recommended: keep the 409.**
2. Ship v1 without an app-merge admin operation? **Recommended: yes, cut it.**
3. Extend Tier B scrubbing to all authenticated captures? **Recommended: yes — scrub value-bearing text, keep structural names.**
4. `reuseFreshCrawl` option to skip RECON on recently-crawled apps? **Recommended: not in v1.**
5. Move runtime DB user off table-owner role now? **Recommended: later, as scheduled hardening; FORCE RLS closes the hole.**

From this assessment:

6. **Does the findings channel jump the queue?** It is the largest product-value item and independent of the oracle fixes. Recommended: run it in parallel with steps 1–2 — different files, different risk.
7. **Embeddings: populate or remove?** Dead columns + a silent spec divergence deserve an explicit call. Recommended: remove from the hot path, revisit with the archetype-fleet work.

---

*Sources: three workflow outputs (31 agents, ~2.1M tokens): plan-vs-built ledger, quality-audit roadmap with 39 verified findings, app-entity architecture plan. Live-DB verifications performed against the dev Postgres (dogfood tenant) on 2026-08-11/12.*
