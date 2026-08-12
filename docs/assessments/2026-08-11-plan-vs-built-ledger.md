# Scoreboard

**54 built / 6 partial / 21 missing / 7 deferred-explicitly / 7 diverged** (95 unique capabilities after merging 8 duplicate audits). Per phase: **RECON** complete (crawler, safety gate, probing, budgets, challenge handling, auth session, capture tiers all built) Â· **COMPREHEND** near-complete (classification, brief, synthesis built; pgvector embeddings never populated) Â· **PLAN** near-complete (catalog, reservation, approval flow built; deselection provenance + Suggest route missing) Â· **WRITE** complete (all gates built; dedup mechanism diverged from spec) Â· **VALIDATE** near-complete (queue, two-tier negatives, seeding built; judge fixtures and worker-side harvest missing) Â· **AUTH/P3** backend complete and live-proven, but the Â§11 consent UX and picker endpoint are unbuilt so users cannot reach it Â· **MAINTAIN/P5** not started (only the content_hash substrate exists) Â· **Pillar B notifications** not started Â· **P6 data governance** not started and accumulating deferred obligations from P2/P3.

# Built and verified

| Item | Evidence |
|---|---|
| RECON crawler: same-origin BFS, own BrowserPool, incremental sink | recon/crawler.ts:83-408; services/test-writer/index.ts; 59 live site_pages rows |
| Interaction safety classifier, ambiguity â†’ mutating, logout blocklists | recon/safety.ts:196-264, :77-93; adversarial tests in __tests__/safety.test.ts |
| Interactive probing (safe-reveal only, budgets, state restore) | recon/probe.ts; crawler.ts:309-337 |
| robots.txt + â‰¤1 req/s + page/depth/probe/timeout budgets | recon/robots.ts; crawler.ts:94,217-226; interfaces.ts:123-132 (maxPages 30 / HARD 50) |
| Challenge-detector reuse â€” blocked, never bypassed | crawler.ts:239-244 |
| survey() mode on PlaywrightDOMPruner (~60-node cap) | playwright.dom-pruner.ts:31-34; crawler.ts:305 |
| Site model tables (029) with RLS, tenant indexes, pgvector | 029_site_model.sql:11-110; all four tables live in DB |
| Per-page classification + content_hash-keyed cache | comprehend/classifier.ts:29-88; site-model.repository.ts:87-94, :180-191 |
| App Brief synthesis + journey graph-verification | comprehend/synthesizer.ts:55-113; pipeline.ts:207 |
| PLAN catalog â€” 31 archetypes, stable-order prompt block | plan/catalog.ts:46-441 |
| ~30% app-specific LLM gap-fill reservation | testwriter.gateway.ts:185-190; pipeline.ts:211-216 |
| Per-scenario provenance stamps (catalog key vs llm) *(audited twice, both built)* | test-planner.ts:100-124; 032:36-37; case-writer.ts:66-73 |
| Plan-approval checkpoint (default review, awaiting_plan_approval) | pipeline.ts:230-239; test-writer.ts:47; 032:14-22; live DB constraint |
| Resume route POST /jobs/:id/plan-approval, empty array = discard | test-writer.ts:318-373; pipeline.ts:362-371,415 |
| Plan-review UI (approve/deselect, notes, NEEDS YOU) | screen-writer.tsx:543-545,611-624; screen-analyses.tsx:27 |
| Plan-screen outline: catalog skeleton / LLM outline Â§9.2 *(audited twice, both built)* | test-planner.ts:119-121; screen-writer.tsx:138-168; writer-catalog.ts |
| Structured-intent WRITE (closed union, elementId grounding, seed tokens) | step-intent.schema.ts:51-127; scenario-writer.ts:112-131 |
| Canonical renderer producing NL sentence + StepAST | canonical-templates.ts:64-99; hash fns imported from learned.compiler |
| No global cache writes from generation; tenant-billed LearnedCompiler | learned.compiler.ts:70-77,133-137; pipeline.ts:545-546 |
| test_steps.compiled_ast storage | case-writer.ts:84-89; validation-runner.ts:103-110 |
| Run path prefers stored ASTs | test-cases.ts:812-871; case-writer.ts:120-136 |
| Gate stack in decided order (schemaâ†’safetyâ†’renderâ†’lintsâ†’dedupâ†’judgeâ†’validate) | scenario-writer.ts:125-184; pipeline.ts:428-492 |
| Schema gate specifics + one repair round | step-intent.schema.ts:117+; scenario-writer.ts:112-131,189-195 |
| Graduated safety filter (three lexicons, stop-before-money, consent flag) | write-safety.ts:23-116; 032:29-31; validation-runner.ts:94,124-133 |
| Render + AST-equality invariant (golden tests) | scenario-writer.ts:150-161; canonical-templates.test.ts:75,100 |
| Free AST lints, advisory-to-judge (4 families) | write/lints.ts:28-90; pipeline.ts:451 |
| VALIDATE via real kaizen-runs queue, draft/rejected promotion | validation-runner.ts:23-25,142-209; live DB 13 drafts / 2 rejected |
| Negative two-tier semantics (Tier-1 lint-enforced, Tier-2 expected-fail) | lints.ts:54-65; scenario-writer.ts:163-170; validation-runner.ts:213-234 |
| Validation runs excluded from customer run lists | runs.ts:137 |
| Analyze wiring (202 + jobId, polling, UI sheet, dedicated queue) | test-writer.ts:167-313; writer-analyze-sheet.tsx:83; queue/index.ts:86,153-158 |
| Token-budget 402 gate on analyze | test-writer.ts:236-252 |
| Init Brief: scrubbed â†’ distilled â†’ tenant_brief JSONB *(audited twice, both built)* | brief-intake.ts:17-60; test-writer.ts:254-274; pipeline.ts:176-197 |
| Coverage gaps (brief flows never observed) as QA deliverable | synthesizer.ts:121-138; pipeline.ts:208 |
| tokenUsage per phase, billed via same billing_events source | pipeline.ts:607-640; test-writer.ts:164 |
| Selector pre-seeding into TENANT selector_cache only *(audited 3Ã—, all built)* | selector-seeder.ts:46,67; validation-runner.ts:138; selector-seeder.test.ts |
| Prompt-injection hardening on crawled text + brief | testwriter.gateway.ts UNTRUSTED_PREAMBLE across all calls |
| Login-recipe in-process execution (Â§4 incl. verification table, fallback chain) | auth-session.ts:127-306; crawler.ts:152-175; auth-session.test.ts |
| Session-loss detection + one-re-login policy | auth-session.ts:316-325; crawler.ts:254-272,64-74 |
| Destination guard (SSRF) at analyze target + every login navigate | destination-guard.ts:23-68; test-writer.ts:183-189; auth-session.ts:168-183 |
| API-time login-case eligibility gates (all five rejections) | test-writer.ts:70,105-149,222-223 |
| Capture tiers A (stub, no classification) / B (passive, scrubbed) | safety.ts:113-137; crawler.ts:288-349,378,425-447; capture-scrub.ts |
| requires_auth partition semantics + publicPartitionUnverified | repository.ts:51-71,228-240; crawler.ts:370; pipeline.ts:345 |
| Consent as row-authoritative trust boundary + migration 034 *(audited twice, both built)* | 034_authenticated_scope.sql applied live; pipeline.ts:62-140; consent-gate.test.ts |
| Role gating + impersonation refusal + consent stamping | test-writer.ts:191-224,287-297 |
| Tenant isolation behind auth (behindAuth flag, no SharedPool) | queue/index.ts:42; worker.ts:789; llm.element-resolver.ts:821-822; services/test-writer/index.ts:60-64 |
| Authenticated generation â€” login prefix on every draft, body-only dedup | validation-runner.ts:100-110,153; pipeline.ts:430,518-556 |
| HARD_BLOCK_AUTHENTICATED lexicon under auth scope | write-safety.ts:44-48,84-86; write-safety.test.ts |
| Signed-out-only archetype exclusion (7 tagged, precondition-based) | catalog.ts:43,437; test-planner.ts:90-93 |
| Sensitive-page exclusion from WRITE targets | pipeline.ts:386-397 |
| VALIDATE with login prefix through normal worker, concurrency 1 | validation-runner.ts:82,138-160,168-181,262-277 |
| P3 live dogfood exit proof (prefixed draft validated GREEN) | spec Â§14.1, job 9b48948b; shared tables byte-identical â€” *see Contradictions* |
| Â§16 resolutions (admin gate, disclosure, no probe pass + flag) | test-writer.ts:205-211; pipeline.ts:345; api.ts:101 |
| B11 touchpoint: resolveCanonicalOrigin alias-table hook | test-writer.ts:70-76,117-134 |
| B11 touchpoint: draft lifecycle reusable by change-triggered generation | test-cases.ts:83-88 ALLOWED_STATUS_TRANSITIONS |

# Partial

| Item | What exists | What's missing |
|---|---|---|
| Site model writes | Page upsert, elements, link graph, App Brief persistence (repository.ts:77-218; 59 pages, 18 briefs live) | pgvector embedding columns never populated â€” zero embedding writes anywhere (grep = 0 hits) |
| 4-dimension batched judge | All four dimensions verbatim, single mini call, before validate, graceful outage (gateway:314-367; pipeline.ts:442-473) | Golden good/bad fixture suite for the judge does not exist; REVISE doesn't ride the repair round (treated as propose-with-findings, pipeline.ts:458) |
| Oracle discovery harvest-to-report | Discover-phrasing assertions; harvestRunState reads finalUrl/alertText from run_events into report (validation-runner.ts:280-304) | Worker records no final URL/heading â€” richer worker-side capture explicitly deferred (comment :252-259); *see Contradictions* |
| Secret-step redaction end-to-end | Single isSecretStep; run_events value+message redacted; global cache skip; L5 prompt omission; per-step screenshot skip (secret-steps.ts; worker.ts:481-507,733) | Â§12.2(4) whole-login-prefix screenshot suppression (payload carries no prefix length); Â§12.2(2) step_results.captured_value redaction (largely moot) |
| P5: RunTrigger 'schedule' | Value in TS union (types/index.ts:368) and DB enum | No enqueue site ever sets it â€” type-level only, no scheduling machinery |
| P5: content_hash diff on re-crawl | Load-bearing substrate: cache nulls classification on hash change (repository.ts:87-94; classifier.ts:13) | No diff report, no new-plan-entry proposal, no removed-page detection â€” nothing consumes the diff |

# Missing with no code or spec

| Item | Planned where | Why it matters |
|---|---|---|
| Deselection provenance in test_plan | P2 refinement Â§3 last bullet | Human-preference signal is silently dropped; approved subset lives only transiently in queue payload |
| POST /suites/:suiteId/suggest (per-page scoped generation) | Plan API section | Suggest button still rendered disabled (new-test-screen.tsx:275); a promised entry point is dead UI |
| Consent UX Â§11 (card, picker, copy, progress/blocked faces, auth stats) | spec-authenticated-scope.md Â§11 | The entire P3 backend is unreachable by users; also carries Â§16.2's "disclosure" obligation. Recorded as remaining work in the spec header |
| Tenant-wide login-test picker endpoint | spec-authenticated-scope.md Â§10.5 | The consent UX cannot be built without it |
| Â§10.3 generation-cost attribution on cases *(audited twice, both missing)* | Master plan Â§10.3, raised 2026-08-06 | No storage, no rendering, never spec'd, no recorded deferral â€” a plan promise with zero footprint |
| Pillar B: 030 notifications migration + webhooks table | Plan Pillar B | 030 slot already taken (test_case_created_by); spec's number must be renumbered to 035+ |
| Pillar B: notifications module (payload-builder, HMAC webhook, slack, queue) | Plan Pillar B | Whole pillar unstarted; spec honestly says "implementation not started" |
| Pillar B: notifications service + Dockerfile + kaizen-webhooks queue | Plan Pillar B | No service dir, no Dockerfile, no queue |
| Pillar B: replace LogNotifier with real INotifier | Plan Pillar B | worker.ts:152 still constructs LogNotifier; escalations go to logs |
| Pillar B: run.completed/failed/escalated + case.suggested producers | Plan Pillar B | Zero grep hits for those event names |
| P5: scheduled re-crawl (repeatable BullMQ jobs) | Plan Phase 6 | src/jobs/ exists but is completely empty; no P5 spec file exists |
| P5: GET /suites/:id/coverage endpoint | Plan Phase 6 | Zero matches; coverageGaps is a different mechanism (LLM judgement, not graph join) |
| P5: stale-test flagging (removed pages + login-case-changed) | Plan Phase 6; spec-auth Â§6.4 | P3 grew P5's backlog (login-case step-hash staleness) with no code |
| P5: run failures feed the knowledge base | Plan Phase 6 bullet 3 | FLAG: no spec or code mentions this anywhere â€” the plan promise has no footprint |
| P6: spec-data-handling.md | Data addendum | docs/specs/platform/ doesn't exist; P6 is accumulating obligations from P2 and P3 while unauthored |
| P6: tenant telemetry opt-out flag | Data addendum bullet 2 | No column, and no telemetry counters to opt out of |
| P6: screenshot retention job + per-suite no-screenshots toggle | Data addendum bullet 3 | P3 built narrower at-source suppression only; no retention controls |
| P6: tenant-offboarding purge path | Data addendum bullet 1 | learned.compiler.ts:130 comment admits global cache lives outside any purge â€” code knows, nothing implements |
| Prompt-version stamping in report (deferral substitute) | Plan deferred bullet 3 parenthetical | The cheap half of the prompt_templates deferral bargain was never delivered (only appBriefVersion exists) |
| B11: change-trigger entry point ({routePatterns, changedLiterals} â†’ drafts) | COORDINATION.md:326-328 | Commitment lives only in COORDINATION prose, in no test-writer spec; not yet overdue (CI v3) |
| B11: route_pattern column on site_pages | COORDINATION.md:308-311 | Contingent on B11 routes manifest; recorded nowhere except a COORDINATION note |

# Diverged from plan

| Item | Plan said | Reality | Recorded decision? |
|---|---|---|---|
| Migration 028 job tables | Separate recon_jobs + generation_jobs | One generation_jobs table for the whole analyze pipeline | **Yes** â€” 028 header comment/spec |
| Kind-aware dedup similarity | P0: hash + embedding cosine >0.92 | Lexical Jaccard 0.9 over normalized action steps (dedup.ts:31-55) | **Partially** â€” kind-awareness was the approved P2 refinement; the embeddingâ†’lexical swap was **silent** (consistent with embeddings never generated, but unrecorded) |
| Draft visibility in case lists | P0: list queries filter status='active' | Default list shows active+draft+validating (test-cases.ts:245-247) | **Yes** â€” spec-draft-review-ux.md:41 |
| Sign-in budget mechanism | Per-JOB cap (default 12) counting crawl + proving-run sign-ins, min interval | Crawl-side-only cap of 3 (crawler.ts:79); proving-run sign-ins uncounted; no distinct interval | **No** â€” more conservative direction, but scope change not found recorded |
| SYNTHETIC-under-auth consent rule | Spec Â§7 matrix: on\|on â†’ still held unvalidated | Code follows the RECORDED revision (da426bf): suite flag governs both scopes (validation-runner.ts:94) | **Yes** for the code â€” but spec Â§7 matrix and write-safety.ts:120-124 comment are stale texts contradicting it |
| scenario_archetype_id on test_cases | Nullable id FK | TEXT archetype_key (032:35-37) â€” can't FK a deferred table | **Yes** â€” migration comment; spec-test-writer-service.md:286 wording predates it |
| Data classification tables | "In P2 scope" per data addendum | Re-deferred to the P6 platform spec (spec-test-writer-service.md:287-290) | **Yes** as re-deferral â€” but the P6 spec it points at doesn't exist |

# Deferred-explicitly, still validly deferred vs deferral-expired

**Still validly deferred:**
- scenario_archetypes table + slot binder + outcome counters + HNSW â€” "no fleet to learn from yet" (catalog.ts:11-13); still true
- G1 outcome-weighted ranking / exemplar retrieval / threshold promotion â€” needs fleet data; still true
- AnthropicGateway + model-weighted billing credits â€” no measured quality gap recorded; *note: the promised substitute (prompt-version stamping) was never delivered â€” see Missing*
- Automated harvest-and-harden re-validation loop â€” doubles validation browser-minutes; harvest-to-report half exists (see Partial)
- BYO LLM key (Â§10.4) *(audited twice, both deferred)* â€” "own phase, enterprise tier"; deferral now recorded in spec-authenticated-scope.md:64 as well

**Deferral-expired:**
- **assert_count-dependent catalog entries** â€” stated reason was an engine gap, and the engine now fully implements assert_count (types/index.ts:45; worker.ts:622-689; playwright.execution-engine.ts:98,759-791) and WRITE's schema already whitelists it (step-intent.schema.ts:105). Catalog entries are unblocked; catalog-v1.md:8 is stale.
- **Authenticated-scope archetypes** â€” stated reason was "waits for P3"; the P3 backend is code-complete on feat/test-writer/authenticated-scope with migration 034 applied and (per the refinements auditor) the live dogfood passed. No one has recorded whether archetype authoring waits for merge â€” at minimum the deferral reason needs re-recording.

# Auditor contradictions

1. **Is the P3 live dogfood done?** The refinements auditor says **built** â€” spec Â§14.1 records job 9b48948b (2026-08-07) with a prefixed draft validated GREEN and shared tables byte-identical â€” and explicitly calls the spec status header and MEMORY.md stale. The pillars auditor (authenticated-archetypes deferral item) says P3 leaves "consent UX + **live dogfood**" remaining, matching MEMORY.md. The refinements verdict wins on primary evidence (the recorded Â§14.1 run); the pillars claim and MEMORY.md are stale. Consent UX genuinely remains.
2. **Harvest-to-report: built or partial?** The pillars auditor (harvest-and-harden deferral item) asserts "the harvest-to-report half IS built". The core auditor marks it **partial**, citing the code's own comment (validation-runner.ts:252-259) that the worker records no final URL/heading, making harvest a best-effort run_events read with richer capture explicitly deferred. Core's verdict kept â€” it engages the caveat the pillars auditor skipped.
3. **Apparent (not real) conflict on "coverage":** core marks brief-grounded coverageGaps **built** while pillars marks the P5 coverage endpoint **missing**. These are different mechanisms (LLM judgement over the brief vs. graph-join of pages against cases) â€” both verdicts stand; COORDINATION.md itself notes the distinction.
