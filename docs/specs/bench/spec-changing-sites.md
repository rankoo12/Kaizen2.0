# Spec: Changing-Sites Engine-Robustness Bench

Created: 2026-10-08
Updated: 2026-10-08 — first full gauntlet run; findings log (§12); matrix
calibrated (cosmetic churn invisible; adapted-at-resolution accepted for
heal-any); libraries vendored into sites; seed-case coverage floor added.

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
| 2 | **Delta name-fidelity exemption**: assert_visible of a RENAMED control passes when resolved via the delta path (refuse-wrong-name gates exempt delta). | OPEN — bench stays red (react-spa FALSE-PASS row) until closed |
| 3 | **Delta memory not fed after a heal**: a delta-scoped assertion after a healed action errors AssertionNoAction — honest failure, wrong reason. | OPEN (stress) |
| 4 | **Volatile-DOM interactions**: chunked re-renders detach nodes mid-action; clear/type/click lose the race. | OPEN (stress — the site exists to measure this) |
| 5 | Heals via FallbackSelector/AdaptiveWait persist nothing — healed-not-learned re-heals every run (GAP verdicts). | OPEN (engine backlog) |
| 6 | **Assertions / actions do not wait for content that renders AFTER an async action** (no navigation). assert_text scans `body` once and Escalation cannot heal it → fail; `type`/`click` resolve onto the nearest already-existing same-named element (a 900ms-late message input lost to the "Messages" nav link). The single most common real-world pattern (optimistic UI, XHR responses). Surfaced by the `social` flagship site. | OPEN — highest-value finding |

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
