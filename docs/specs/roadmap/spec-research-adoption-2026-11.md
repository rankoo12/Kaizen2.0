# Spec: Research adoption — November 2026

Created: 2026-11-08
Updated: 2026-11-08 — S1 shipped (PR #105); S4 gains run-outcome-deferred
heal persistence (residual of the #16 fix on fix/engine/heal-trust).
Updated: 2026-11-08 (later) — heal-trust merged (PR #106); finding #14
(behindAuth on the case) shipped early via migration 045 instead of waiting
for S4 — S4 keeps the prompt-cache scoping review.
Updated: 2026-11-08 (latest) — S2.1 shipped (model routing + reasoning_effort
guard + retirement warning, defaults unchanged); real-API smoke A/B done
(Luna 10/10 = gpt-4o-mini 10/10, JSON mode OK, effort none OK; an overstated
reasoning-cost claim corrected with measured numbers).
Updated: 2026-11-08 (later) — S2.2 (the paid real-API A/B) CANCELLED by the
owner: project rule is zero OpenAI spend, everything validated locally. The
Luna flip becomes an operator env change before 2027-01-14 (runbook callout in
spec-deployment §4); S2.3–S2.5 deferred. See §S2 status.
Updated: 2026-11-08 (S2b) — Playwright retargeted 1.65 → 1.64.1 (1.65 is
inside the 7-day release-age window and brings an accessible-name change);
aria-contract check added. See §S2b.
Updated: 2026-11-08 (S4a) — run-outcome-deferred heal persistence shipped
(social 21/3/1/0 → 24/0/1/0, no poison rows). See §S4.
Status: ACTIVE — this is the decision record for docs/research/2026-11-08.md
and docs/research/2026-backfill.md. Items not listed under §2 or §3 were read
and deliberately not adopted.

## 1. Provenance and verification

The research was audited against the repo before adoption (2026-11-08):
hard-coded `gpt-4o-mini` confirmed at openai.gateway.ts:135/284 (+ metadata
226/316) and model-tier.ts defaults; all five `node:20` images confirmed;
`playwright ^1.49.1` range vs pinned 1.58.2 Docker images confirmed (the
lockfile-regen drift warning is real); fastify ^4.28.1, openai ^4.104.0,
@anthropic-ai/sdk ^0.39.0 (no imports — dead), next ^15.3.0 / react ^19.2.4
confirmed. External dates/prices (gpt-4o retirement Jan 14 2027, Node security
release Nov 11, Luna/Haiku pricing) are adopted provisionally — **each sprint
re-verifies its own load-bearing external facts against primary sources at
sprint start.**

## 2. Adopted, in execution order

### S0 — Finish the site-portfolio campaign (in flight; the instrument)
Remaining: T2×wp-admin isolation cross-half, fleet regression `--all`, Sonnet
control legs, the judge-everything dashboard from campaign.jsonl. Everything
below is MEASURED by this harness, so it completes first. Owner: this session.

### S1 — Security & runtime sprint (~3 days; hard external deadlines)
- Node 20 → 24 in all five Dockerfiles + `ci.yml` + engines (research: Node 20
  EOL, HIGH fixes land on 22/24/26 only, cited Nov 11).
- Next 15.5.15 → latest patched 15.5.x + patched react 19.2.x. Add the test
  the research proposed: a forged session cookie must get 401 from the
  backend (middleware gates on cookie PRESENCE by design; prove the backend
  holds). Next 16 is a separate, later task.
- Fastify 4 → 5.12.x (EOL + CVE-2026-25223 on schema-validated routes).
- Data-tier pins: pgvector image by digest on PG ≥16.15 (CVE-2026-14666 —
  and PROVE the "runtime is superuser, RLS inert" claim with a query before
  scheduling the unprivileged-role work), redis ≥7.4.9, nginx ≥1.30.2.
- npm hardening: `.npmrc` min-release-age, `npm ci` in Dockerfiles,
  `--ignore-scripts` where sharp/playwright allow, minimal CI permissions.
- Gate: typecheck, full jest + integration suites, stack boot, one bench
  spot-run (social) green.

### S2 — LLM gateway modernization (3–4 days; hard-fails Jan 14 2027)

**Status 2026-11-08 — S2.1 SHIPPED (plumbing, zero behavior change by default);
S2.2 CANCELLED, S2.3–S2.5 DEFERRED — see the bullets below** (the separate "S2b"
section further down is Playwright, unrelated). Facts re-verified against OpenAI's primary pages
(developers.openai.com deprecations + `gpt-6-luna` model page): `gpt-4o-2024-08-06`,
`gpt-4o-2024-11-20` and `gpt-4o-mini-2024-07-18` shut down **2027-01-14**
(announced 2026-10-14), replacement `gpt-6-luna` ($0.10 in / $0.01 cached /
$0.50 out per 1M; 1.05M context; `reasoning.effort` none|low|**medium (default)**
|high|xhigh|max; Chat Completions supported, function calling only with effort
`none`). Corrections to this section's own text: the router is `modelFor(tier)`
(not `getModelForTier`); `OPENAI_MODEL` in `.env`/`.env.example` was dead config
that nothing read; and the Test Writer gateway already honored the tier env — the
real exposure was the runtime gateway's two HARDCODED `'gpt-4o-mini'` calls.

- **S2.1 (shipped, PR #108):** every model-calling site routes through
  `model-tier.ts` (lazy env read); `reasoning_effort` is emitted only for models
  that accept it (gpt-6-* gets `none` on the mini tier — see the measured note
  under S2.2 for why); billing records the model actually used; both gateways log
  `llm.model_retiring` at boot while a retiring model is configured. **Defaults
  deliberately unchanged** (gpt-4o-mini / gpt-4o): the request on the wire is
  byte-identical to before (verified by capturing raw HTTP bodies for default,
  Luna, an effort override, and an ignored override).
- **S2.2 — CANCELLED 2026-11-08 by the owner.** It was to be a paid, full-bench
  A/B against the real API (estimated $1–2 to replay the whole archived history,
  ~9.1M input tokens). Project rule instead: **zero OpenAI spend — everything is
  validated locally on the Claude subscription.** The local inbox answers with a
  weak Claude model regardless of the requested model name, so it can prove wire
  shape but NOT Luna's quality; therefore Kaizen's tooling does not validate the
  Luna flip and the defaults in `model-tier.ts` stay on gpt-4o-mini / gpt-4o. **The
  flip is an operator action before 2027-01-14** — set `KAIZEN_LLM_MODEL_MINI` and
  `KAIZEN_LLM_MODEL_FRONTIER` in production (config only, thanks to S2.1) and canary
  it; the runbook callout is in spec-deployment §4, and both gateways warn at boot
  while a retiring model is configured. What follows is the only evidence that
  exists, recorded for the operator's confidence, not as an acceptance test.
  - **Smoke A/B DONE 2026-11-08 (real API, ~$0.01 — taken BEFORE the rule was
    restated; not to be repeated; same 10 prompts through the real
    gateway — 7 compileStep incl. the assertion-polarity and count traps + 3
    resolveElement incl. the 4-inert-decoys reactor and row-context disambiguation):**
    `gpt-4o-mini` 10/10, `gpt-6-luna` 10/10 (effort `none`), identical tokens
    (16,068 vs 16,028) and latency (11.7s vs 11.4s). This closed three open
    questions: the tenant key is live with Luna access; **JSON mode works on Luna**
    (the risk flagged because its page only lists structured outputs); and
    `reasoning_effort: "none"` is accepted on Chat Completions.
  - **Negative control, measured — correcting an assumption:** Luna at its default
    `medium` effort used 16,244 tokens (+1.3%) and 12.3s (+7%) vs `none`. The
    adaptive reasoning barely engages on trivial classification, so the earlier
    claim that `medium` would "bill reasoning tokens on every compile/resolve" was
    overstated. `none` stays (lowest latency, determinism, and function-calling
    requires it) but it is NOT a large cost saving. Small sample, easy prompts.
  - **Why no local substitute exists, for whoever reconsiders:** services read
    `OPENAI_BASE_URL` from `.env` (the local inbox) and each gateway uses ONE client
    for chat AND embeddings, so any real-provider test must also keep embeddings on
    the bench's instant hash vectors (a chat-only passthrough in the inbox) or the
    semantic-guard behavior changes and results stop being comparable with the
    haiku-floor baseline. That design is what a future, explicitly-funded A/B would
    need. Note the compose `CHOKIDAR_USEPOLLING` does not make the API's `tsx watch`
    reload — restart containers after any change.
- **S2.3 / S2.4 / S2.5 — DEFERRED, not cancelled.** openai SDK v4.104 → v7 (its
  `ReasoningEffort` type predates `none`; the single cast in `reasoningParamsFor`
  would go away), cache layout / `prompt_cache_key` / cached-token billing, Flex
  tier for background calls. All three change real-provider behavior that cannot be
  validated locally, v4.104 already works with Luna per the smoke test, and none has
  a deadline — revisit when the provider path is next touched on purpose.

Follows backfill §3.2 as written, with these repo-specific points:
- Route openai.gateway.ts:135/284 through `getModelForTier()` — the retirement
  cannot be fixed by env alone (verified).
- Mini default → the 4o-mini replacement (cited: gpt-6-luna,
  `reasoning_effort:"none"` explicitly); pick the frontier tier deliberately.
- Cache layout (static → breakpoint → snapshot), `prompt_cache_key=tenantId`,
  log cached/write tokens into billing_events (fixes embedding-tokens gap).
- Flex tier for test-writer + Explorer background calls (retry→Standard on 429).
- openai SDK v7 (requires Node ≥22 → strictly after S1). Drop
  `@anthropic-ai/sdk` or bump it for a Haiku 5.5 fallback — not both halfway.
- **Verification = rerun the campaign harness**: the haiku-floor records in
  campaign.jsonl are the baseline; Luna (and optionally Haiku 5.5 via real
  API) must match or beat 4o on FALSE-PASS (must stay 0), heal rates, token
  trajectory. The must-fail probes are the regression net for prompt drift.
- Optional inside S2 (1–2 days): `DecisionsResolver` prototype behind the
  gateway interface, per-tenant flag. The keeper idea: calibrated
  `probabilities` as the confidence-decay SEED. Single-vendor/single-model —
  never the spine, always with the current path as fallback.

### S2b — Playwright 1.58.2 → 1.64.1 (own PR); 1.65 deferred
Pin the exact version (kill the `^1.49.1` drift), bump the Docker images in
the same PR. **Target changed from 1.65 to 1.64.1 (2026-11-08)** after reading
every release's notes and the registry:
- 1.65.0 was published 2026-11-05 — younger than the repo's own 7-day
  `min-release-age` policy (S1), so CI would refuse it until 2026-11-12.
- The 1.65 accessible-name change (text the browser does not render — unslotted
  text, closed `<details>` — leaves accessible names and aria snapshots) is
  1.65-specific; 1.64.1 does not have it, so no cache migration is needed yet.
- 1.64.1 carries a regression fix for Chromium 155+ aborting cross-origin
  redirects when any route is registered (Kaizen registers none), and ships
  Chromium 156 vs today's 145 — the security reason to move at all, since the
  worker browses arbitrary customer sites.
- Removed/changed APIs 1.59–1.64 (`Locator.ariaRef`, snapshot-update mode) are
  not used anywhere in `src/`.

**The real risk is the aria-snapshot format, not the API surface.** The DOM
pruner patches every candidate's accessible name from the first line of
`locator.ariaSnapshot()` (`parseAriaSnapshotName`), and cached `role=X[name="Y"]`
selectors are minted from it; a format or name-computation shift would silently
degrade hot runs into re-resolution. `scripts/playwright-aria-contract.ts`
(`--write-golden` / `--check`, run inside the worker container) compares, for 18
tricky elements, the raw first snapshot line, the parsed name, and whether
`role=…[name=…]` round-trips to exactly one element, against a golden recorded
under the previous pinned version. **Run it before and after every Playwright
bump.** Known pre-existing gap it records rather than fixes: when a name contains
a colon (`New: Save` via CSS `::before`) Playwright YAML-single-quotes the line,
`parseAriaSnapshotName` returns null and the pruner falls back to its own
computed name.

**Result 2026-11-08 — SHIPPED on 1.64.1 / Chromium 156.** Contract `--check`
against the 1.58.2 golden: 18/18 identical. Benches run with the cache left
untouched (rows minted under 1.58.2 must still serve): vanilla 5/0/0/0 with ZERO
LLM calls and ZERO heals in every phase (cleanest name-drift signal — every cached
`role=…[name=…]` row served), social 21/3/1/0 (= baseline exactly), nightmare
6/1/2/0 (baseline 6/0/3/0; the reactor case healed onto the real control this
round — a model pick, still "healed-not-learned" by design — FALSE-PASS 0, both
must-fail probes red). Round 1 (unchanged site) flips were 2 improvements + 1
minor in social, 1 improvement + 1 regression in nightmare; the regression
(Portal modal, `StepWatchdogTimeout` on "Summon modal") has the same signature as
two failures at 12:35 and 12:51 BEFORE the bump — the known seeded-latency flake
(finding #13), not the browser. Extra LLM resolutions in social r1 are cache
carryover (each bench run ends on v2, so the next run starts on v1 with v2-era
rows for renamed elements), not drift. Side facts: the worker and test-writer
images ship **Node 26.13** (supported by Playwright, covered by the Nov 11
security release — closes S1's open note on those two images); after a container
recreate Docker Desktop's IPv6 port proxy can hang, so point the bench at
`KAIZEN_API=http://127.0.0.1:3000`.

**1.65 later** (eligible once it clears the release-age policy): re-record
nothing — run `--check` against the 1.64.1 golden; the two cases pre-recorded for
it (`closed-details-text`, `unassigned-slot-text`) are expected to drift, and the
research's re-derive migration for mismatched cached rows ships with that bump,
measured as HOT-PHASE TOKEN DRIFT on the bench (hot >0 tokens = name drift). The
pruner `mode:'ai'`/`getByRef` refactor is a separate later step.

### S3 — Trust pack: test-writer quality gates (3–5 days)
Backfill §3.6 adopted whole: deterministic oracle-strength lint before the
judge, assertion-weakening guard on repairs/heals, judge "no evidence =
Inconclusive", cross-step symbolic oracles, judge validation with kappa +
swapped order. This converts the bench's internal honesty culture into
customer-visible product — the direct answer to Momentic/Checksum and the
top recurring user complaints (silent passes, agents gaming tests).

### S4 — Shared-pool write-path governance (~1 week)
Backfill §3.4, with two repo corrections:
- The gap analysis STARTS from what exists: cache-semantic-guard, suspect-pick
  eviction + refusal, archetype verdict-cooldowns, heal provenance
  (`attribution.healed` → `SelectorSet.healProvenance`), outcome windows.
  Several AdaptiTest stages are already built; do not rebuild them under new
  vocabulary.
- **Campaign finding #14 — SHIPPED early, separately (2026-11-08,
  migration 045)**: behindAuth now travels with the CASE (`test_cases.
  authenticated`, derived from the generation job's scope at creation and
  sent by the single case-run enqueue site). It was a tiny, high-value
  security fix that did not need to wait for the sprint. What REMAINS for S4
  on this boundary: review prompt-cache tenant scoping (the campaign
  observed cross-tenant prompt-cache replays — fine for public pages, needs
  a decision for private ones), and consider letting the worker re-derive
  behindAuth from the case as defense in depth for any future enqueue site.
- New pieces adopted: scope filter INSIDE the pgvector query (+
  `hnsw.iterative_scan`), N-distinct-tenant promotion with provenance
  columns, expected-state predicate (URL pattern + landmark signature) on
  cache rows — the predicate would also have caught finding #6's family
  earlier — and quarantine-not-delete demotion.
- **Run-outcome-deferred heal persistence — SHIPPED 2026-11-08 (S4a,
  fix/engine/deferred-heal-persistence).** The heal-trust branch gates
  persistence+provenance on MAJORITY name agreement, which closes the poison
  vector but made sub-majority legit renames (Post → Publish, Accept → Confirm)
  re-heal every run instead of learning. Implemented as: `ResolveAndRetry` hands
  a sub-majority heal back as a `deferredPersist` closure (the engine passes it
  through); the worker records it with one fact measured BEFORE the healed click
  — whether the text of the assertion right after it was already on the page —
  and at run end commits it only if (1) the run passed, (2) an `assert_text`
  directly follows the healed action (a plain `wait` is transparent; any other
  interaction ends the search), and (3) that text was demonstrably ABSENT
  before the click (all frames; "could not tell" is never "absent"). Everything
  else is discarded and the cache is untouched; the decision is written to the
  run log in plain words. Provenance is stamped `corroboration: 'outcome'`
  (name-agreeing heals are `'name'`) so the two are never mistakable. Proving
  runs never defer. Rules live in `src/workers/deferred-heals.ts`. Verified:
  social 21/3/1/0 → 24/0/1/0, nightmare 6/0/3/0 with nothing cached for the
  vault probe, captcha or the inert-decoy heal. **Known limits, deliberately
  conservative:** only `assert_text` corroborates (a visibility-only assertion
  never does); an assertion whose text was already on the page cannot show which
  element was clicked, so such renames stay re-healing GAPs; text rendered only
  inside an unreadable cross-origin frame yields "unknown", i.e. no learning.
  **Still open in S4:** the rest of the shared-pool governance work below.

## 3. Deferred, with reasons

| Item | Why deferred | Revisit when |
|---|---|---|
| RECON state-graph explorer (backfill 3.5) | Mission-5-sized (1–2 weeks); engine trust sprints outrank coverage breadth | After S4 |
| Bot-protection kit + Web Bot Auth signing (3.8) | No Cloudflare-fronted customer yet; the kit is days when one appears | First external design partner |
| Pricing / plan limits / escrow (3.7) | Needs the CI wedge + unit economics from a deployed instance first (product plan P1/P2) | After CI wedge |
| WebHarbor bench sites | Campaign v2 material; current portfolio still yields findings | Next campaign |
| Voyage 4 / halfvec | Only if HNSW RAM or vendor lock bites | Issue 2 trigger |
| BullMQ 6 | Cheap but zero-urgency; ride along after S1 | With S2 infra window |
| MCP server / MCP Apps | Distribution play, premature pre-revenue | After pricing |
| Stealth/anti-detect anything | Research and we agree: signed identity, never stealth | Never (posture) |

## 4. Standing instruction for the research loop

Future research runs must ingest `docs/specs/bench/spec-changing-sites.md`
§12 (the findings log) and the campaign records as rating inputs — findings
#11–#14 are internal evidence the 2026-11-08 edition could not see, and at
least one (#14) changed a sprint's scope. Keep the (2°) source marks and the
"not relevant" discipline; they are what made this edition auditable.
