# Spec: Research adoption — November 2026

Created: 2026-11-08
Updated: 2026-11-08 — S1 shipped (PR #105); S4 gains run-outcome-deferred
heal persistence (residual of the #16 fix on fix/engine/heal-trust).
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
- **Campaign finding #14 folds in here**: behindAuth must travel with the
  CASE (persist authenticated scope at case creation; worker derives
  behindAuth from the case, payload flag as override). Same boundary, same
  sprint. Also review prompt-cache tenant scoping (the campaign observed
  cross-tenant prompt-cache replays — fine for public pages, needs a decision
  for private ones).
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
