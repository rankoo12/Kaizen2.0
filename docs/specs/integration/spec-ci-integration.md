# Spec: Kaizen in CI/CD (B11)

Created: 2026-08-07
Status: Design — agreed in discussion; v1 cut chosen; implementation not started.

Backlog item **B11** in [spec-feature-backlog.md](../roadmap/spec-feature-backlog.md).
Related: [spec-keys-quota-authorship.md §4.1](../roadmap/spec-keys-quota-authorship.md)
(keys cannot run a saved case — a v1 prerequisite), the test-writer pipeline
(`feat/test-writer/*`, another agent's workstream — see the 2026-08-07 cross-note in
`COORDINATION.md`), and B2 (test drafts, blocked on `028_test_writer`'s `status` column).

---

## 1. Thesis

Kaizen tests a **URL, not a build artifact** — so its slot in a pipeline is after the
preview deploy: push → build → deploy preview → Kaizen runs against the preview →
the result gates the merge.

B11 looks like "trigger runs from CI." It is actually **making a run's origin a
first-class fact** — branch, commit, PR, environment — that the brain, the gate, and
the report all key on. The trigger is the small part; the environment model is the
feature.

## 2. Personas and permissions

- **Developers** (anyone who can open PRs on the connected repo): can view and edit
  the tests their PR affects. Identity bridge: **Sign in with GitHub** — repo
  membership on the connected repo grants dev-tier access to the workspace. Repo
  membership *is* the ACL; Kaizen administers no per-test permissions.
- **The Kaizen owner**: governs the system, not the tests — budgets, keys, gate
  policy, environment aliases, brain verdicts (pins/blocks), promotions. Owner is the
  existing Kaizen-native role (already gates admin-key minting).

Kaizen is the **destination, not plumbing**: tests live in Kaizen, devs get a link
into it ("affected tests"), nothing is installed or stored on their machines. There is
no tests-as-YAML-in-repo mode; the DB remains the single source of truth for test
definitions.

## 3. Integration surface — one engine, thin adapters

### 3.1 The universal contract (the engine)

A CLI (and the `POST /runs` API beneath it) that every adapter wraps:

1. Takes an execute-scoped API key + target URL (+ optional case/suite selectors).
2. Enqueues, polls to terminal status.
3. **Exit code** non-zero on failure — the gate every CI tool understands.
4. **JUnit XML** report — the universal format every CI tool renders natively.
5. Posts the **PR/MR comment** via the platform API (§7).
6. Reads provenance from the platform's standard env vars and passes it through:
   `GITHUB_SHA`/`GITHUB_REF`/`GITHUB_HEAD_REF`, `CI_COMMIT_SHA`/`CI_MERGE_REQUEST_IID`,
   etc.

Anything that can run a shell command supports Kaizen; adapters are convenience.

### 3.2 Adapters

**GitHub Actions is the primary target** — it is where most repos live, and every phase
lands there first. Other platforms are adapters over the same contract, built on demand.

| Platform | Shape | Notes |
|---|---|---|
| GitHub Actions | Composite action `kaizen/run@v1` | **Primary.** Key from secrets, URL from the deploy step's output; ~4 lines in the customer's workflow |
| GitLab CI | CI component/template via `include:` | On demand. Key from CI/CD variables; comment via MR notes API; gate via merge checks |
| Jenkins | Bare CLI in a `sh` step | On demand only. JUnit plugin ingests our XML |
| Everything else | The CLI directly | Bitbucket/CircleCI/Azure reduce to exit code + JUnit |

### 3.3 v2 trigger — GitHub App (zero YAML)

Install once; Kaizen subscribes to `deployment_status` webhooks and auto-runs the
mapped suite whenever a preview deploy reports ready. Results post as **Checks**, the
comment as today. Removes the workflow-step wiring entirely. Requires the provenance
columns (§4) since no adapter passes them. Repo read access (`Contents: read`) is an
**optional enrichment** requested separately — it powers selection tier (a) (§6) and
the test-writer handshake (§9); crawl/brain-only operation stays the baseline because
many tenants will decline code access.

### 3.4 Credentials

v1: execute-scoped API keys in CI secrets (shipped — scoped, revocable, per-pipeline).
Later: **OIDC federation** — the CI job proves identity with the platform-minted OIDC
token, Kaizen exchanges it for a short-lived run token. No stored secret, and the
token carries repo+branch — provenance and auth from one mechanism.

## 4. Provenance schema

New nullable columns on `runs`: `branch`, `commit_sha`, `pr_number`, `ci_provider`;
`triggered_by` gains `'ci'`. Additive migration.

> **Migration numbering:** `032` is taken by `feat/test-writer/generation-pipeline`
> (`032_test_writer_p2.sql`) and `033` by `033_frame_url.sql` (B9 branch). B11
> migrations start at **034**.

## 5. The environment model (the real feature)

`selector_cache` is keyed `(tenant, content_hash, domain)` — no dimension for *which
instance* of the app knowledge came from. CI is exactly the world where one app is
many instances (prod, staging, preview-per-PR). Two failures, one cause:

- **Preview domains** (`app-pr-123.vercel.app`) cold-start the brain — the key is too
  volatile. Every CI run re-pays the model for elements the brain already knows, and
  LLM resolution is also *slow*, so the gate's latency and cost fail together.
- **Side-by-side versions** thrash one cache row — the key is too coarse. A preview
  run heals a selector the PR changed, writes it back, prod's run heals it back:
  ping-pong forever.

### 5.1 Domain aliasing (reads)

Tenant-configured alias patterns map preview domains to a canonical domain
(`app-pr-*.vercel.app → app.example.com`). Cache **reads** on a CI run go through the
alias — warm resolution against the learned brain. Configured by the owner; no
auto-detection (a wildcard guessed wrong would cross-contaminate genuinely different
sites).

### 5.2 Copy-on-write brain overlay (writes)

CI runs **never write the canonical brain**. Learns and heals from a PR run land in an
overlay scoped to the PR/branch:

- Read-through: overlay first, canonical second.
- **Merge → promote** the overlay into canonical (the PR's UI just became prod's UI —
  the brain learns the redesign before prod first runs it). **Close → discard.**
- Schema shape: nullable `environment`/`branch` dimension on `selector_cache` rows
  (NULL = canonical), one additional read-through tier in `CachedElementResolver`.

v1 ships aliasing (reads) with **cache writes suppressed** on CI runs: warm reads, no
poisoning; a changed element re-pays per push until merge. The overlay is the v2 fix
for that re-payment.

## 6. Affected-test selection — three indexes, all harvested from execution

Selection is the pitch, not an optimization: "I renamed Login to Sign in and Kaizen
ran exactly the 3 relevant tests" is the demo. Principle: **a test's true dependency
set is everything it touched while running — and we run it, so we record it.**

| Index | Harvested from | Catches |
|---|---|---|
| **Elements** | learned selectors + `step_results.target_hash` | UI changes (the rename) |
| **Endpoints** | Playwright network capture during ordinary runs | backend changes |
| **Traversal** | per-run step/page flow history | structural/navigation changes |

- **The greppable-diff trick:** our selectors are semantic
  (`role=button[name="Login"]`), so the diff's changed string literals grep directly
  against learned accessible names → exact elements → exact tests. Likewise backend:
  route paths are string literals (`'/auth/login'`) that grep against recorded network
  logs. No AST, no coverage instrumentation. CSS/XPath tools cannot do this — their
  selectors contain no human strings.
- **Composition:** union of all signals, never intersection. Over-selection is safe;
  under-selection lies to the gate. Shared-file fan-out ("touches everything") → run
  everything, correct and conservative.
- **Floors:** an owner-marked always-run smoke tier on every PR; a nightly full run on
  main as backstop.
- **The learning loop:** any test predicted unaffected that fails/heals anyway is a
  labeled example that tightens the index. Prediction errors are training data.
- **Honest zero:** code unreachable from the UI (cron, queue consumers) selects zero
  UI tests beyond smoke — rightly; running irrelevant tests isn't gating, it's
  performing.

## 7. Gate semantics and the PR comment

Three-valued gate:

- **failed** → red, blocks merge.
- **passed** → green.
- **healed** → **green, plus a PR comment**: healing is the product working, but the
  developer must see their change moved something. Comment content already exists —
  the step's NL text, the `was → now` selector diff from `healing_events` (A1), a link
  to the run + screenshot.

The comment also carries: affected-test list with statuses, proposed new tests (§9),
and token cost — which doubles as a **UI blast-radius report** ("this change
invalidated 12 learned selectors"), a diff sized in user-facing impact.

Known limit, stated: healing can mask a real regression (a removed element healed onto
a lookalike). The verdict/pin system is the human check; the comment's heal diff is
what makes that check possible at review time.

## 8. PR-scoped test drafts

A dev editing a test from a PR context ("the button is Sign in now") must not change
the live test — it would break main/prod runs until merge. Edits become **draft
versions bound to the PR**: promote on merge, discard on close — the same lifecycle as
the brain overlay (§5.2). Depends on B2 / the test-writer's `status` column
(`028_test_writer`), which becomes load-bearing here.

## 9. Test-writer handshake

With repo access, the test-writer's pipeline gains: PR diffs as a change feed for
COMPREHEND (no re-crawl diffing), **change-triggered generation** (diff touches a
component → propose a drafted test in the PR comment; approval = the same draft
promotion as §8), and source as comprehension evidence beside PageCaptures. Question
posted to that workstream 2026-08-07 in `COORDINATION.md` (what COMPREHEND wants from
a repo); their answer shapes this section. Their plan-approval checkpoint remains for
UI-initiated generation; CI-initiated proposals ride the PR.

## 10. Phasing

| Phase | Contents |
|---|---|
| **v1** | Workflow-step trigger (composite action + bare CLI recipe); keys run saved cases; provenance columns (034); domain aliasing reads + writes suppressed on CI runs; **element-index selection** + smoke tier + nightly backstop; JUnit + exit code; PR comment (affected/healed/cost). No App, no overlay, no drafts. |
| v2 | GitHub App (`deployment_status`, Checks, zero YAML); copy-on-write overlay + promote-on-merge; endpoint index (network capture); GitLab component. |
| v3 | PR-scoped drafts + change-triggered generation (with test-writer); OIDC exchange; traversal index + learning loop. Non-GitHub adapters (GitLab component, Jenkins) only when a tenant asks. |

### v1 acceptance

1. A PR to a connected repo runs only the tests the element index selects (plus
   smoke), against the preview URL, with cache reads warm through the alias.
2. The renamed-button case: exactly the dependent tests run; the run heals; the gate
   is green; the PR comment shows the `was → now` diff and cost.
3. A failed run blocks the merge via commit status; JUnit renders in the Actions UI.
4. `runs` rows carry branch/commit/pr/provider; the Kaizen run screen shows them.
5. Canonical `selector_cache` rows are byte-identical before and after a CI run
   (write suppression proven), while resolution sources show cache hits (alias
   proven).

## 11. Out of scope / open questions

- Monorepos mapping several apps to one repo (which alias, which suite?).
- Gate SLA target (suite wall-clock budget under selection) — measure v1 first.
- CI run quotas vs the tenant token budget (a hot PR loop can drain a month's budget;
  probably a per-PR run cap owned by the owner).
- Promotion of overlay entries that conflict with concurrent main-branch learning
  (last-write vs confidence-weighted merge) — decide with real data in v2.
