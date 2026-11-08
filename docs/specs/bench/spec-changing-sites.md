# Spec: Changing-Sites Engine-Robustness Bench

Created: 2026-10-08
Updated: 2026-10-08 — first full gauntlet run; findings log (§12); matrix
calibrated (cosmetic churn invisible; adapted-at-resolution accepted for
heal-any); libraries vendored into sites; seed-case coverage floor added.
Updated: 2026-10-11 — findings #7 (hover-reveal), #8 (scroll-to-find), #9
(suspect-refusal) closed with live verification; #6 recovery amended
(refuse, don't restore, an unrecovered suspect). Social: 21 PASS / 3 GAP /
3 FAIL / 0 FALSE-PASS (remaining FAILs: composer rename-decoy heal ×2,
navigate-profile TIMING — pre-existing, unchanged).
Updated: 2026-10-11 (later) — full-fleet verification: 4 sites green, stress
improved vs 10-08 baseline (reds = known #3/#4), zero regressions. Finding
#2 (delta name-fidelity) FIXED and verified (react-spa BENCH GREEN). Social
suite hygiene: archived the stale "Empty post" seed (UX removed from the
site, see fleet.ts note) and the mis-generated "Comment appears" draft
(typed its comment into the main composer; its old green was a sloppy-delta
coincidence — real coverage lives in the "Replying to a post" seed). Fleet
hard FAILs now: stress #3/#4 ×3 + social navigate-profile TIMING ×1.
Updated: 2026-11-08 — findings #15 (one-shot heal vs late renamed targets)
and #16 (name-blind heal adoption shielded by provenance) FIXED on
fix/engine/heal-trust and bench-verified on nightmare: ResolveAndRetry now
retries the re-resolve up to 3× within the watchdog budget, and persistence
+ provenance require MAJORITY name agreement — the first cut's narrower
"no words agree" gate let an inert decoy sharing one word ("Activate" for
"Activate reactor") persist with provenance and be served-and-trusted; the
gate now matches the serve-time gate it bypasses. Sub-majority picks heal
the run only (partial overlap outranks zero as the fallback), so a legit
sub-majority rename re-heals each run — an honest, budget-bounded GAP until
S4's run-outcome-deferred persistence. The gate scores the QUOTED name when
the step has one (context words must not dilute an exact-name pick), and the
L5 write-back strips `attribution.healed` when it rewrites a row's selectors
(provenance must not outlive the selectors it certified). Social cost
accepted and documented: zero-overlap renames (composer "Post"→
"Publish" ×2, requests "Accept"→"Confirm") drop PASS→GAP healed-not-learned.
Verified: nightmare 6/0/3/0 (same sealed shape, must-fails red),
heal-attributed cache rows after two full loops = exactly the name-true v1
cookie heal, zero mismatches.

## 1. Goal & non-goals

Prove the engine — the L0–L5 resolver waterfall plus the healing chain —
survives **website change**: a fleet of local synthetic sites mutates between
suite runs, and the engine must detect the drift, heal onto the right
elements, persist what it learned, and **fail honestly** where the feature is
genuinely gone. A false-pass (a green run on a removed/changed feature, or a
heal that grabs a lookalike) is the hardest possible bench failure.

Non-goals (v1): fixing the gaps the bench exposes (e.g. heals that persist
nothing — measured and reported, not patched here); real-embedding semantics
(see §9); multi-tab sites; authenticated sites.

Zero OpenAI spend: every model call routes to the local inbox; chat prompts
are answered by a minimal Claude subagent (haiku), embeddings by instant
hash vectors.

## 2. Architecture

```
benchmarks/sites/<id>/{v1,v2,...}   committed site versions (static, CDN-script max)
benchmarks/sites/<id>/live/         runtime docroot (gitignored) — the harness swaps it
compose service `sites`             one nginx:alpine, hostname alias per site
                                    (site-vanilla, site-react, site-angular,
                                     site-vue, site-jquery, site-stress)
benchmarks/sites/nginx.conf         map $host → <id>/live; caching disabled;
                                    inline robots.txt; NO SPA fallback
```

Load-bearing decisions:
- **Same hostname across versions.** `selector_cache` is keyed by exact
  hostname; swapping content behind one host is what keeps the stale selectors
  the healing chain must recover from. A different URL per version would
  silently bypass the entire heal path.
- **No SPA fallback in nginx** — a fallback-to-index would 200 a REMOVED page
  and false-pass the must-fail mutations. SPA sites use hash routing so they
  never need one.
- **Caching disabled everywhere** (etag/if_modified_since/sendfile/
  open_file_cache off, `Cache-Control: no-store`) so a docroot swap serves on
  the very next request. The mutator additionally refuses to proceed until
  `__version.txt` AND a per-version content marker are demonstrably served.
- **LLM chokepoint**: `OPENAI_BASE_URL=http://host.docker.internal:4141/v1`
  (the inbox) is the only airtight zero-spend boundary. `DISABLE_LLM` must
  NEVER be used for this bench — it does not gate healing and *increases* LLM
  traffic by starving the resolver.
- **Heal budget**: `ResolveAndRetryStrategy` persists heals but is capped
  per tenant per hour (default 2). The bench needs many re-resolutions per
  mutated suite run → `HEAL_RESOLVE_RETRY_PER_HOUR=50` in `.env` (engine
  change: the cap is env-overridable, read per call) and the harness clears
  `healing:*` between phases.

## 3. Site fleet

| Site | Host | Stack | Unique coverage | v2 mutations |
|---|---|---|---|---|
| vanilla | site-vanilla | multi-page static HTML | pure cross-page nav, zero framework noise | cosmetic id/class churn (login+contact); unrelated-content section on home; pricing byte-identical |
| react-spa | site-react | React 18 UMD, hash routes, ~300ms late render | fully client-generated DOM | label-rename ("Sign in"→"Log in"); dom-restructure (nav + grid wrappers) |
| angular-forms | site-angular | AngularJS 1.8 CDN, form-heavy | dense type/select/check + validation messages | element-swap (submit button→a[role=button]); **assertion-changed (must-fail)** |
| vue-cart | site-vue | Vue 3 CDN, list/cart | repeated similar elements | **decoy-added** ("Checkout tips", data-decoy); element-moved (real Checkout below list) |
| jquery-classic | site-jquery | jQuery 3 DOM-manip (tabs/accordion/modal) | exists-hidden vs created-on-demand elements | dom-restructure (accordion reordered+wrapped); **feature-removed (must-fail: Reports tab gone)** |
| stress | site-stress | vanilla JS, skeletons, chunked lists | timing robustness, compound failures | delayed-render (refresh widget 20s late) + cosmetic churn under the delay |
| social | site-social | React 18 SPA, 7 views, tunable per-endpoint latency | **flagship complexity** — feed/stories/composer/search/profiles/friends/messages/groups/notifications; most tests + most failure points | label-rename+decoy (Post→Publish), feature-removed (Stories), assertion-changed (share copy), element-moved, dom-restructure, cosmetic-churn, Accept→Confirm, notifications 6s + feed batch-2 4s late |

Design rules: every v2 keeps ≥1 untouched flow held to strict
`pass-unchanged`; **no settings-toggle / delete-own-record levers anywhere**
(standing prohibition — the angular site's settings page became a read-only
directory for exactly this reason); every interaction ends in visible outcome
text so generated tests can assert honestly.

## 4. Mutation taxonomy → expected outcomes

Calibration reality (first live loop, 2026-10-08): the engine caches
role/name-shaped selectors for labeled controls, so **pure id/class churn is
invisible** — vanilla r2 passed 5/5 with zero heals. Dead selectors mostly
classify **TIMING** (the classifier can only prove SelectorGone for
name-encoding selectors), so expectations carry accepted-sets, not single
classes.

| Mutation class | Expected outcome | Notes |
|---|---|---|
| cosmetic-churn | pass-or-heal | calibrated: usually survives untouched |
| label-rename | heal-any | name-anchored cache dies; heal must land on the renamed control |
| dom-restructure | pass-or-heal | role selectors survive; css-path caches must heal |
| element-swap | pass-or-heal | role=button matches a[role=button] |
| element-moved | pass-or-heal | same name, new location |
| decoy-added | decoy-resist | green AND no selector touches a decoy marker |
| delayed-render | pass-or-heal | must never FAIL; AdaptiveWait or re-resolve |
| feature-removed | **must-fail** | green = FALSE-PASS, hard bench failure |
| assertion-changed | **must-fail** | asserting vanished copy must fail; assertion heals must refuse |
| unrelated-content | pass-unchanged | 0 heals, cache-only sources, 0 resolution tokens |

## 5. Expectations schema

`benchmarks/changing-sites/lib/types.ts` — `SiteExpectations` per site:
regex `CaseMatcher` (namePattern / stepPattern over the run's joined step
text), first match wins, and **unmatched cases fall to
`defaultOutcome: 'pass-unchanged'`** so an unanticipated mutated flow fails
loudly instead of slipping through a lenient default. Expectations may
constrain `allowedStrategies` / `allowedFailureClasses` and carry
`decoyMarkers`.

## 6. Harness

`npm run bench:sites -- --site X | --sites a,b,c | --all [--skip-analyze] [--rounds N]`

**Sites run in parallel** — one suite + one analyze job each
(`TESTWRITER_CONCURRENCY=6`), per-site prefixed logs, one slow site never
blocks the fleet.

Per-site phases: preflight (inbox probe, live/→v1 + served-version probe,
bench-tenant budget grant) → analyze v1 (maxPages 6, maxScenarios 8,
planApproval auto; facts/explore off) → accept validated drafts (poll out of
`validating`, PATCH to active) → **r1 baseline** (all pass; selector-cache
snapshot) → **mutate** (swap live/, probe-verified) → clear `healing:*` +
`llm:dedup:*` ONLY (never the selector cache — the staleness is the test) →
**r2 mutated run** → 5s settle (heal persistence is fire-and-forget) →
**r3 learned-proof run** → evidence JSON to results/ (gitignored).

Judging is a separate replayable pass: `npx tsx
benchmarks/changing-sites/judge-cli.ts [--site X]` over the latest evidence.

## 7. Judge (lib/judge.ts — unit-tested like product code)

Verdicts: **PASS** · **GAP** (healed-not-learned: a non-persisting strategy
healed; next run re-heals — reported, not failed, in v1) · **FAIL** ·
**FALSE-PASS** (hard failure).

Per outcome:
- `pass-unchanged`: r2 passed, zero healing events, zero resolution tokens.
- `heal-learned`: r2 healed with a succeeded `ResolveAndRetryStrategy` event;
  r3 passed with no heals (the persisted selector served).
- `heal-any`: healed by any strategy; learning sub-classified → GAP if none
  persisted.
- `must-fail`: r2 failed; green = FALSE-PASS; r3 must fail again.
- `decoy-resist`: green AND no `selector_used`/`new_selector` in r2 or r3
  contains a decoy marker; a decoy grab = FALSE-PASS.

Fleet-wide negative controls on every green run:
`AssertionHealedOntoDifferentElement` must never appear (the worker's refusal
to certify assertion heals onto different elements must have fired as a
failure, never under green), and no selector anywhere may match a decoy
marker.

## 8. Bench pass/fail

Hard fails: any FALSE-PASS, any decoy grab, any negative-control violation,
a learned heal that doesn't serve from cache on r3, any FAIL on an untouched
(`pass-unchanged`) flow. Reported-not-failing: GAP counts (healed-not-learned),
unvalidated draft counts.

## 9. Known harness limitations

- **Hash embeddings**: identical text → cosine 1.0, different text → ~0. L3/L4
  vector tiers and `ElementSimilarityStrategy` are effectively exact-text-only
  under the inbox — never *require* `element_similarity` in an expectation.
  A future variant can swap in real embeddings for a semantics-focused run.
- **Classifier TIMING skew**: role/CSS selectors that die report TIMING, not
  ELEMENT_REMOVED — accepted-sets everywhere.
- **Haiku answerer variance**: briefs are deliberately prescriptive (naming,
  outcome-verifying final steps); fallback `ANSWERER_MODEL=sonnet` documented;
  re-answers persist in the inbox file cache so only failed prompts re-spend.
- **Windows docroot swap is not atomic**: mutations happen only between runs,
  verified by HTTP probes before any run starts.

## 10. Runbook

```
docker compose -p kaizen20 up -d          # stack incl. `sites`
npm run inbox                              # terminal 2
ANSWERER_MODEL=haiku npm run answerer      # terminal 3 (sonnet = quality fallback)
npm run bench:sites -- --all               # terminal 1
npx tsx benchmarks/changing-sites/judge-cli.ts
```

`.env` requirements (all present): `OPENAI_BASE_URL` → inbox,
`KAIZEN_ALLOW_PRIVATE_TARGETS=1`, `HEAL_RESOLVE_RETRY_PER_HOUR=50`,
`TESTWRITER_CONCURRENCY=6`. Never set `DISABLE_LLM`.

Troubleshooting: stale `.kaizen-llm/pending` files → answerer died, restart
it; malformed haiku JSON → delete the bad `.kaizen-llm/cache` entry and
re-answer (or switch the answerer to sonnet); a site serving the wrong
version → the mutator's probe error names the dir to check; analyze blocked →
the job error in `generation_jobs.error` says which sign-in/safety gate fired.

## 11. Scoreboard format

```
site               PASS  GAP  FAIL  FALSE-PASS  neg-ctrl
vanilla               n    n     n           0         0
...
BENCH: GREEN — no false-passes, no decoy grabs, no negative-control violations.
```

Committed result records live in daily reports; raw evidence JSONs stay
gitignored under benchmarks/changing-sites/results/.

## 12. Findings log

First gauntlet (2026-10-08) — scoreboard 22 PASS / 3 reds, each red a named
finding (docs/reports/2026-10-08.md has the full narrative):

| # | Finding | Status |
|---|---|---|
| 1 | **Phantom heals**: a heal "succeeded" by locating an element; the action was never re-executed. A test ending on a healed click would have been a false-pass. | **FIXED** — worker re-executes non-assertion heals and only counts a verified action (src/workers/worker.ts) |
| 2 | **Delta name-fidelity exemption**: assert_visible of a RENAMED control passes when resolved via the delta path (refuse-wrong-name gates exempt delta). | **FIXED 2026-10-11** — an assertion's INTERACTIVE delta pick sharing ZERO salient words with the target (role included, so "a confirmation dialog" still matches a dialog; prose picks exempt — that lookup is the delta oracle's point) is demoted to no-pick → honest fail. Verified live: react-spa must-fail flipped FALSE-PASS→PASS in r2 AND r3 (`refusing the lookalike` log on "Log in" vs "Sign In button"); react-spa BENCH GREEN, 0 false-passes fleet-wide. |
| 3 | **Delta memory not fed after a heal**: a delta-scoped assertion after a healed action errors AssertionNoAction — honest failure, wrong reason. | **FIXED 2026-10-11** — the "what changed" capture is a shared closure now called from BOTH success paths: the direct pass and a heal whose re-executed action passed (the baseline from before the first attempt still anchors the diff). Verified live: stress "Refresh stats button updates dashboard metrics" FAIL→PASS, healed click + delta-fed assert green in r2 AND r3. |
| 4 | **Volatile-DOM interactions**: chunked re-renders detach nodes mid-action; clear/type/click lose the race. | OPEN (stress — the site exists to measure this) |
| 5 | Heals via FallbackSelector/AdaptiveWait persist nothing — healed-not-learned re-heals every run (GAP verdicts). | **FIXED 2026-10-11** (for the ResolveAndRetry path — the one that persists). THREE stacked causes, each caught live: (1) the worker's name gates saw the RENAMED control's learned row as suspect and evicted it every run → `attribution.healed` stamp on the heal's persist, surfaced as `SelectorSet.healProvenance` (redis payload v4), trusted by the gates for INTERACTIONS only; (2) the persist was UPDATE-only and the recovery gates had usually already evicted the row — zero rows matched, nothing learned → UPSERT on (tenant_id, content_hash, domain); (3) the heal embedded `rawText` while the read-time semantic guard compares the canonical `action + targetDescription` text — under exact-text hash embeddings every healed row was semantic-rejected and DELETED at the next resolve (the heal un-learned itself) → the heal now embeds the resolver's own canonical texts. Verified live: social r2 `db_exact/healed` → r3 `db_exact/passed` ZERO heals for both rename seeds; social 24 PASS / 0 GAP / 1 FAIL / 0 FALSE-PASS. AdaptiveWait/Fallback heals still persist nothing by design (they found the SAME selector; there is nothing new to learn). |
| 6 | **Wrong element resolved under async latency** (the precise form of what was first logged as "doesn't wait for late content" — assert_text in fact polls ~8s; the real failure was upstream). On a still-rendering page the only control present is persistent chrome, `pickTopCandidate` picks it, and the name-blind element cache rubber-stamps it (the Notifications bell served for "Add friend"/"Play"/"Create event"; the composer for "the comment field") — so the action fires on the wrong element and the honest assert then fails. | **FIXED 2026-10-11** — worker suspect-pick recovery: when an interaction's resolved element shares ZERO salient words with the target (or a fill action lands on a link), evict the poisoned cache entry, settle patiently, re-resolve cache-first, adopt only a non-suspect result. Verified live: social went 13→20 PASS; reply/add-friend/accept/create-event/play all recovered; rename+decoy safety intact. `nameAbsent` unit-tested. *Amended 2026-10-11*: an UNRECOVERED suspect is now REFUSED (fail into healing) rather than restored — restoring and acting on a confirmed zero-overlap pick is the one move that can't be undone (the bell "passed" a click meant for the renamed "Accept", and the heal chain never got its turn; requests.rename, v2). |
| 7 | **Hover-gated menus are unreachable**: a control inside a CSS `:hover`-revealed menu (Buzzly's profile "Block") is never surfaced by the pruner and cannot be clicked; the engine has no hover-to-reveal capability. | **FIXED 2026-10-11** — `src/workers/reveal.ts` + two worker hooks (resolution ends empty/suspect, AND a failed retryable interaction): scan for a HIDDEN carrier of the step's name, hover its nearest visible ancestor, verify visibility, act on the revealed element (`resolutionSource 'reveal'`, never cached — the stamp dies with the page). Verified live: block seed PASS on v1 via reveal AND on v2 via the action-failed hook. Spec: specs/workers/spec-hover-reveal-scroll-find.md |
| 8 | **No scroll-to-find**: content outside a virtualized list's rendered window (post #120 of 500) is not in the DOM and the engine never scrolls a container to locate it. | **FIXED 2026-10-11** — `scrollSweepForText` in the engine: after the ~8s assert_text poll misses, advance every scrollable container viewport-by-viewport re-scanning between steps; keep the scroll on a find, restore on a miss. Verified live: deep-row seed PASS r1/r2/r3 (`engine.assert_text_scroll_found` ×3). |
| 9 | Residual of #6 on the messages thread: the 900ms-late message input still loses occasionally (step depends on the previous click opening the thread). | **FIXED 2026-10-11** — closed by the suspect-refusal change to #6's recovery: an UNRECOVERED suspect pick is now refused (empty set → classify→heal) instead of restored-and-acted-on; restore-original only survives for non-suspect picks. The message seed now passes; "Accept"→"Confirm" rename heals via ResolveAndRetry on the first honest failure. |
| 10 | **Recovery stack can out-spend the step watchdog, and the killed step records nothing**: on a slow-rendering page (stress v2 delayed render) resolution + empty-retry settle + suspect settles + reveal scans + heal-chain waits can sum past `STEP_WATCHDOG_MS` (60s, step-loop.ts). The watchdog fails the run mid-flight: the step_result carries NO failure class, NO error type, NO heal events — the bench sees only `failed: #1 ?`. | **FIXED 2026-10-11**, three parts: (a) *stamps* — `onStepWatchdog` hook fires before teardown; the worker records a failed step_result with `StepWatchdogTimeout` + a run-log line naming the spent budget (proven live: every former `failed: #1 ?` now carries the stamp); (b) *budget* — executeStep carries a soft deadline (80% of the watchdog); the empty-retry, suspect-loop iterations and reveal hooks check remaining budget before spending, and the heal chain won't START with <10s left (an honest classified failure beats a half-finished heal); (c) *deliberate patience* — the budget guards exposed that a stress "pass" depended on recovery layers ACCIDENTALLY wasting time until the 20s-late widget existed, so AdaptiveWait now scales its wait to `HealingContext.deadlineAt` minus a 15s ResolveAndRetry reserve (the waiter must never starve the re-resolver that fixes renames), classic 10s floor. Stress: 2→3 PASS (best ever), delivery-row-click FAIL→PASS, refresh seed healed via ResolveAndRetry-after-reserve; both remaining FAILs carry honest evidence (watchdog stamps / AssertionNothingChanged) — residual run-to-run volatility is finding #4's domain. |
| 11 | **No overlay-dismissal recovery** (nightmare, 2026-11-01): a consent wall appearing 3s after load intercepts every click under it; the engine's recoveries all assume the target is missing or hidden — none can see "the right element is there, something else is on top of it" and go dismiss the obstruction the way a human does. Every below-fold interaction dies on the watchdog (stamped, per #10a). | OPEN (capability; candidate design: on a click intercepted by an overlaying element, surface the intercepting element and try its dismiss affordance once) |
| 12 | **Scroll-to-find does not wait for lazy-loaded growth** (nightmare ledger, 2026-11-01): the sweep advances through EXISTING scroll height and stops when nothing moves — a container that grows asynchronously after a scroll-triggered batch load (multi-second seeded delay) never gets its new rows scanned. Deep content behind infinite scroll is unreachable. | OPEN (capability; extend the #8 sweep: after "nothing advanced", wait briefly for scrollHeight growth before concluding) |
| 15 | **The heal chain is one-shot against late-appearing renamed targets** (nightmare cookie family, sonnet control 2026-11-08): the banner button both RENDERS LATE (3s) and is RENAMED in v2. AdaptiveWait waits for the DEAD old selector; ResolveAndRetry re-resolves ONCE against whatever DOM exists at that instant — fire before the renamed button renders and nothing ever retries the re-resolve. Race proven live: in one round the same step healed in one case (heal ran after 3s) and watchdogged in two others (heal ran before). Model-independent (identical under sonnet). Fix direction: on a failed re-resolve for TIMING-class failures, retry the RE-RESOLVE within the remaining budget (the patience belongs to the resolver, not only the waiter); related: AdaptiveWait should not receive the scaled budget at all when its selector has never matched this run (dead-selector TIMING misclassification, reactor locus). | **FIXED 2026-11-08** (fix/engine/heal-trust) — ResolveAndRetry re-prunes and re-picks up to 3× (HEAL_RESOLVE_RETRY_WAIT_MS between attempts, deadlineAt-aware). Verified live: the renamed 3s-late cookie wall heals in r2/r3 for every below-fold case across two loops (pre-fix the subscribe case could never heal at all); remaining per-round variance is #13 model latency vs the watchdog, not one-shot-ness. AdaptiveWait dead-selector budget note stays open under #13. |
| 16 | **Heal adoption is name-blind, and heal provenance then SHIELDS the wrong adoption** (closed-vault probe, sonnet control 2026-11-08): the unreachable "Secret vault" click healed onto `role=button[name="Summon modal"]` — zero salient overlap — because a click's outcome-validation (the click dispatched) is too weak to catch a wrong element; the downstream assert failed honestly (defense in depth held, 0 false-pass), but ResolveAndRetry PERSISTED the wrong selector with `attribution.healed`, and `SelectorSet.healProvenance` (the #5 fix) makes the name gates TRUST that row on every later run — a self-shielding poison. Purged from the bench cache by hand this once. Fix direction: a heal whose adopted descriptor is nameAbsent vs the target may heal the RUN but must NEVER earn the provenance stamp (and arguably must not persist at all); provenance is for renames with corroboration (outcome-verified assert downstream, or countDrift/partial overlap), not for any click that dispatched. | **FIXED 2026-11-08** (fix/engine/heal-trust) — persistence + provenance now require MAJORITY name agreement (nameOverlaps), matching the serve-time gate that provenance bypasses; sub-majority picks heal the run only (partial outranks zero as fallback) and NEVER cache. Hardened mid-verification: the first cut gated on nameAbsent alone and the bench immediately produced poison #2 — the inert decoy `text="Activate"` (one shared word with "Activate reactor") persisted with provenance and was served-and-trusted into a failing click every run. Gray-zone lesson: any persistence gate weaker than the gate provenance bypasses IS the poison vector. Second hardening (social spot-run): the gate scores the QUOTED name when present, like the serve gate — scoring the full description let context words dilute an exact-name pick (`the "Accept" button for "Sam Idowu"` healing onto the actual "Accept") into a refusal. Third hardening (acceptance-query forensics): the L5 write-back's upsert REWROTE a row's selectors while INHERITING its `attribution.healed` — a row stamped for "Post" was rewritten to the renamed "Publish" and kept claiming heal-validated trust it never re-earned (healed_at predating the rewrite was the tell). The stamp belongs to the selectors it was earned with: `writeCacheRow` now strips `healed` on every selector rewrite. Verified: after two full nightmare loops the only heal-attributed row is the name-true v1 cookie heal; vault and decoy persist nothing; must-fails stay red. Residual (S4): sub-majority legit renames re-heal each run (honest GAP) until run-outcome-deferred persistence can corroborate before caching. |
| 14 | **behindAuth protection does not travel with the case** (wp-admin leg, 2026-11-01): the flag is set by the test-writer for PROVING runs of authenticated-scope jobs only; an ordinary `/suites/:id/run` of those same cases runs with behindAuth falsy, so a cache-miss LLM resolution of an admin-page INTERACTION would pass the `!behindAuth` gate and teach the global, tenant-free archetype library a customer's private UI vocabulary. Audited not to have happened in this campaign (the leg's only LLM step was an assertion on a public page; zero archetype_learn events; the flagged archetype was pre-seeded in April) — but the gate is one cache eviction away from leaking. Fix direction: persist authenticated scope on the CASE at creation; worker derives behindAuth from the case, with the payload flag as an override. | OPEN (product security; fix post-campaign — engine frozen) |
| 13 | **The 60s step watchdog does not scale with model latency** (nightmare × haiku, 2026-11-01): a weak answerer's single resolution call can take 30–100s on a heavy DOM, so slow-model + slow-site combinations blow the watchdog before any recovery runs. The budget-aware layers (#10b) manage time INSIDE the budget; nothing sizes the budget to the model actually answering. | OPEN (engine backlog; sonnet control legs quantify the delta) |

### `social` (Buzzly) v2 — rebuilt big/modern/weird, 2026-10-08

Rebuilt as a component-based (htm + React, no build step) 7-view SPA — a tiny
store, custom hooks, UI atoms across `lib.js`/`widgets.js`/`views.js`/
`views2.js`/`app.js` — with a battery of adversarial patterns and per-endpoint
tunable latency (`data.js` `BUZZLY_LATENCY_MS`). 27 active cases (7 generated +
20 seeds incl. 8 reach probes). **Result: 15 PASS / 1 GAP / 11 FAIL / 0
FALSE-PASS / 0 negative-control** — every red a named finding on the hardest
site in the suite.

- **Engine wins on hard patterns**: open **shadow-DOM** poll vote, **iframe**
  widget interaction, element-swap (Join → `<a role=button>`), plus all the
  standard flows (like, share, search, story, group join, notifications).
- **Correct reach limits (must-fail, green)**: **canvas** text is unreadable
  (assert→body→Escalation, no false pass); the **infinite-spinner** live tile
  times out honestly and never invents a pass.
- **Reachable-but-missed (red findings, finding #6 family)**: the late-rendered
  **outcome-text** asserts after an interaction are not caught — reproduced
  across reply, add-friend, send-message, **block** (hover menu → `<dialog>`),
  **create-event** (stacked modals), and **play-video** (Watch); plus
  **scroll-to-find** on the virtualized 500-row feed (post #120 not in the DOM
  until scrolled). These are the highest-value gaps the site exposed.
- The renamed "Post"→"Publish" (beside a decoy) and "Accept"→"Confirm" healed
  to the right control; the decoy was never grabbed.

### `social` (Buzzly) — original version, added 2026-10-08

A 7-view React social app (feed, stories, composer, explore/search, profiles,
friends, messages, groups, notifications) with every loading time in one
tunable table (`data.js` `BUZZLY_LATENCY_MS`) and ~10 named v2 mutations.
First run: **9 PASS / 2 GAP / 3 FAIL / 0 false-pass / 0 decoy** (24-scenario
analyze budget + 12 seeds). The must-fails (Stories removed, share copy
changed) failed honestly; the renamed "Post"→"Publish" (beside a decoy) and
"Accept"→"Confirm" healed to the right control with the click re-executed
(GAP only on persistence); the 3 FAILs are all finding #6.

Positive proofs from the same runs: honest failure on changed assertion text
(all strategies refused, twice) and on a removed feature; decoy resisted;
label rename absorbed both by fresh L5 re-pick (adapted) and by a real
ResolveAndRetry heal with the re-executed click verified; id/class churn
invisible to the role-shaped cache.
