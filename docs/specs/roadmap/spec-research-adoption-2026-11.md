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
reasoning-cost claim corrected with measured numbers); the Luna flip is gated
on the full-bench S2.2 A/B. See §S2 status.
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
S2.2–S2.5 below remain** (the separate "S2b" section further down is Playwright,
unrelated). Facts re-verified against OpenAI's primary pages
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
- **S2.2 — the A/B that earns the flip (gated, PAID):** the local inbox answers
  with a weak Claude model regardless of the requested model name, so it can prove
  wire shape but NOT Luna's quality. Validating Luna needs real OpenAI calls on the
  tenant key. **Cost, measured:** the whole archived request history (3,513 calls,
  ~9.1M input tokens, every bench since the inbox started) would cost roughly $1–2
  to replay on Luna — cost is not the constraint, discipline is. Acceptance for the
  flip: FALSE-PASS stays 0, heal rates and the must-fail probes match the
  haiku-floor baseline in campaign.jsonl.
  - **Smoke A/B DONE 2026-11-08 (real API, ~$0.01, same 10 prompts through the real
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
  - **Still to do before the flip:** the full-bench A/B (nightmare + social + the
    fleet at `--skip-analyze` against the real API with
    `KAIZEN_LLM_MODEL_MINI=gpt-6-luna`; the containers must be pointed off the local
    inbox for it, e.g. via a temporary compose override — do not leave `.env`
    edited), then flip the defaults in a small evidence-bearing PR. Deadline
    2027-01-14; no rush, but do not let it drift into January.
- **S2.3** openai SDK v4.104 → v7 (its `ReasoningEffort` type predates `none`; the
  single cast in `reasoningParamsFor` goes away). **S2.4** cache layout /
  `prompt_cache_key` / cached-token billing. **S2.5** Flex tier for background calls.

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

### S2b — Playwright 1.58.2 → 1.65 (same infra window as S1/S2, own PR)
Pin the exact version (kill the `^1.49.1` drift), bump the Docker images in
the same PR. The 1.65 accessible-name change (unrendered text excluded) can
silently invalidate cached `role=X[name="Y"]` rows: measure it as HOT-PHASE
TOKEN DRIFT on the bench (hot >0 tokens = name drift), and ship the research's
re-derive migration for mismatched rows rather than letting them decay. The
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
- **Run-outcome-deferred heal persistence** (from the #16 fix, 2026-11-08):
  the heal-trust branch gates persistence+provenance on MAJORITY name
  agreement, which closes the poison vector but makes sub-majority legit
  renames (cookie "Accept the inevitable" → "Fine. Proceed.") re-heal every
  run instead of learning. The corroboration that distinguishes a right
  zero-overlap rename from a wrong pick is the RUN'S OUTCOME: hold the
  pending persist in the worker and commit it only when the healed step's
  downstream steps pass. Lands here, where write-path trust rules live.

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
