# Spec — Test Writer UX ("Kaizen as a QA engineer" in the app)

Created: 2026-08-06
Updated: 2026-08-17 — §0.0 build status added (the "implementation not started"
header was two shipped PRs out of date); §11.6 enumerates the Mission 1 remainder.
Status: **Substantially implemented** — see §0.0. §11.1–§11.4 shipped in
`6e99583`, `2143df1` and `3e56294`; the remainder is §11.6.
Supersedes the UI portions of `spec-draft-review-ux.md` §2 (which targeted the
dormant SideRail/TopBar tree — see §0.1). The case-lifecycle contract in that
spec's §1 still stands.

---

## 0. Ground truth (read before designing anything else)

### 0.0 What is built (audited 2026-08-17)

This spec was written as a design. Most of it then shipped, and reading it as a
to-do list now produces duplicate work. The audit:

| Surface | State |
|---|---|
| `screen-writer.tsx` — four faces, phase rail, plan rows, delivery, halted | **built** |
| `writer-analyze-sheet.tsx` — URL, brief, synthetic-data consent, advanced | **built** |
| `use-generation-job.ts` — single-job poller (2s / 10s / stop) + suite history | **built** |
| `kaizen-app.tsx` — writer screen, File-menu entry, delivery scan across suites | **built** |
| `screen-tests.tsx` — empty-state hero, ✦ Analyze, draft badges, delivery banner | **built** |
| `app-brief-card.tsx`, `screen-analyses.tsx` (job history as a screen) | **built** |
| `report.progress` written by the pipeline at phase boundaries (§11.0-d) | **built** |
| Findings section on the delivery face (`spec-findings-and-coverage.md` §3) | **built** |
| `outline` / catalog skeleton shown per plan row | **built** |
| **Signed-in exploration** — still the disabled "soon" row | **not built** |
| **PLAN phase progress write** — the rail never lights `PLAN` | **not built** |
| **Away-from-screen channel** — document title, sidebar chip, transition toasts | **not built** |
| **Deselection provenance** — declined scenarios are discarded, not recorded | **not built** |
| **Findings on halted/blocked faces** — the report carries them; the face drops them | **not built** |
| **Coverage** — `GET /suites/:id/coverage` is complete and has zero UI | **not built** |
| **Suggest** — no route, no pipeline mode (`spec-scoped-suggest.md`) | **not built** |

Keep this table current. A spec that claims less than the code is as misleading
as one that claims more, and this one was misleading in both directions at once.

### 0.1 The live shell is `kaizen-app.tsx`, not the routed shell
`packages/web/src/app/(app)/layout.tsx` renders `<KaizenApp />` and states that
"the old SideRail/TopBar shell and the per-route pages are no longer rendered."
The real app is `packages/web/src/components/design/kaizen-app.tsx` — an
in-memory screen switcher (`tests | author | run | runs | brain | usage`) with
`MenuBar`, `Sidebar`, `Toast`, `Sheet` from `components/design/chrome.tsx`.

Consequences:
- The disabled Sparkles "Suggest" button at `components/organisms/new-test-screen.tsx:275`
  is **dead code**. The live authoring surface is `components/design/screen-author.tsx`.
- All new components go in `components/design/*` following the `screen-*.tsx`
  convention — not the dormant atoms/molecules/organisms tree.
- "Survives navigation" means: survives screen switches inside KaizenApp AND
  full page reloads. Job state must live in the DB (it does) and an app-level
  hook — never screen-local state.

### 0.2 Use design tokens, never raw hex
Three appearances (`aperture` default, `light`, `dark`) driven by semantic
tokens in `packages/web/src/app/aperture.css`: `--accent/--accent-soft`,
`--pass`, `--fail`, `--heal`, `--warn`, `--cache`, `--idle` (+ `-soft`), `--sep`,
`--fill`; utilities `.card .list .row .badge .btn .seg .field .pill .meter
.spinner .sheet .label .num .mono-chip .rise .hide-md/.hide-lg/.hide-narrow`.
The Ocean-Serenity palette is the brand intent the light theme expresses;
hardcoding `#397C82` breaks aperture and dark.

Semantic mapping for this feature: generated/AI provenance = `--accent`;
proof/success = `--pass`; needs-consent/unproven = `--warn`; rejected = `--fail`;
healed-during-proof = `--heal`; in-flight = `--idle` + `.spinner`.

---

## 1. The gating model

### 1.1 Two checkpoints, two different questions

| | Plan checkpoint | Draft review |
|---|---|---|
| Question | "Is this the right thing to attempt?" | "Do these proven tests express my intent?" |
| Information | Intent only — nothing has run | Full evidence: green run, screenshots, harvested oracles |
| Prevents | **Irreversible things**: real actions on the customer's site, token/browser spend | Nothing irreversible — only what joins the suite's contract |
| Reversible? | No | Yes — `active → archived` is one click |

**Design law: put the mandatory gate before the irreversible action; use
reversibility instead of approval after it.**

### 1.2 What machines can prove, and what they can't
Already proven before a draft exists: it executes (validation run), it isn't
vacuous (judge D1 pre-state test), negatives are sharp (D2), it's realistic and
non-duplicative (D3/D4 + dedup), every element was actually observed (schema gate).

What no filter can prove: **that the test encodes intended behaviour rather than
current behaviour.** A generated test is derived from the app *as it is*; if the
app has a bug today, a perfectly-validated test can assert that bug forever. The
delta between "matches current behaviour" (machine-provable) and "matches intent"
(human-only) is exactly the set of existing bugs. The discover-oracle harvest is
the concrete instance: Kaizen observed *something* after submit — only a human
knows whether "Thanks! We'll be in touch" is success or a swallowed error.

So a human touch on drafts is epistemically irreducible. The question is its shape.

### 1.3 One gate, one acceptance, and a trust ladder

**Gate (blocking): plan approval.** As specced — `awaiting_plan_approval`,
default `review` on first analyze, `auto` afterwards. Consent, spend, steering
and blast radius are decided here.

**Acceptance (non-blocking, batch-shaped): the delivery.** Draft review is
reframed, not removed: the completed job presents proven drafts *with evidence
inline* and one primary action — **"Add all N to the suite."** One click, not N
decisions. Per-row exclusion available. Drafts carrying an open question
(unproven-for-consent, healed-during-proof, unhardened oracle, Tier-2
expected-fail) are quarantined into "Needs a decision", which bulk-accept skips.
Mechanically unchanged (`draft → active`); only the ergonomics collapse.

Why not zero-touch auto-activation: Kaizen's trust story is *"you saw the
proof."* A suite whose contents nobody chose stops being the team's definition
of green. One click on the payoff screen is not friction — on first run it IS
the wow moment.

**The trust ladder** (per suite):

| Rung | Plan | Drafts |
|---|---|---|
| 1 — Review everything (default, first analyze) | pause at checkpoint | batch-accept on delivery |
| 2 — Plan-only autopilot | `planApproval:'auto'` | batch-accept on delivery |
| 3 — Hands-off (future) | auto | validated drafts auto-activate; delivery becomes an **undo** surface |

Rung 3 needs `suites.auto_accept_validated` (§11.0-i) and is on the roadmap
explicitly rather than smuggled in.

---

## 2. Information architecture

### 2.1 New surfaces

`kaizen-app.tsx` navigation state gains:
```ts
const [writerFocus, setWriterFocus] = useState<{ suiteId: string; jobId: string | null } | null>(null);
// screen: 'tests' | 'author' | 'run' | 'runs' | 'brain' | 'usage' | 'writer'
```

```
KaizenApp
├─ MenuBar                    + File ▸ "Analyze an app…"
├─ Sidebar (chrome.tsx)       + activity chip when jobs are live (§6.2)
│                             + pulsing dot on a suite row with an active job
├─ TestsScreen                + empty-state two-path hero (§4.1)
│                             + "✦ Analyze" toolbar button (suite view)
│                             + draft/validating badges, Drafts filter,
│                               delivery banner, App Brief card
├─ AuthorScreen               + "✦ Have Kaizen write these" → Analyze sheet
├─ RunScreen                  + proof-run provenance banner (§4.9)
└─ NEW WriterScreen (screen-writer.tsx) — one screen, four faces:
     PROGRESS    (queued / running)
     PLAN REVIEW (awaiting_plan_approval)   ← the trust-winning screen
     DELIVERY    (completed)
     HALTED      (failed / blocked / empty)
   + AnalyzeSheet (writer-analyze-sheet.tsx)
```

**One screen with faces, not four screens**: the job is one continuous story; the
user re-enters repeatedly over ~5 minutes from toasts/chips and must always land
on "where things are now". Face selection derives purely from polled job state,
so deep entry is stateless: `go('writer', {suiteId, jobId})`.

The Brain screen is deliberately NOT the App Brief's home: Brain is element-level
tenant-wide memory; the App Brief is suite-scoped app comprehension.

### 2.2 Changes to existing files

| File | Change |
|---|---|
| `kaizen-app.tsx` | `writer` screen wiring; app-level `useActiveGenerationJobs()`; toasts; File-menu item |
| `chrome.tsx` Sidebar | activity chip + per-suite active dot |
| `screen-tests.tsx` | empty-state hero; `✦ Analyze` button; draft badges; `Drafts` filter option; delivery banner; App Brief card |
| `screen-author.tsx` | ghost button → AnalyzeSheet with URL prefilled |
| `screen-run.tsx` | provenance banner for `triggeredBy === 'testwriter'`; `PROOF` trigger badge |
| `icons.tsx` | add `compass`, `clipboard`, `shield`, `layers` |

---

## 3. End-to-end journey

### 3.1 First run (new suite, zero tests) — ~6 minutes
- **t+0:00** Empty state leads with the capability: *"Point Kaizen at your app.
  It explores it like a QA engineer on day one, writes a test plan, and proves
  every test it proposes — before you accept a single one."*
- **t+0:10** AnalyzeSheet sets honest expectations: URL (staging nudge), optional
  brief, unchecked consent with consequences stated both ways, and what will
  happen (read-only exploration, minutes, a few cents, a pause for approval).
- **t+0:12** PROGRESS face: phase rail, elapsed timer, *"Visiting up to 30 pages
  at about one per second — reading only, never submitting."* User leaves; the
  document title carries state.
- **t+2:40** Toast: *"Test plan ready — Kaizen is waiting for you."* PLAN REVIEW
  opens with what Kaizen KNOWS (app type, pages, verified journeys), a coverage
  gap, and scenario rows with rationales and provenance. User deselects one,
  adds a steering note, clicks **Write & prove 5 tests**.
- **t+5:30** Toast: *"4 tests proposed — every one proven with a real run."*
  DELIVERY shows drafts with PROVEN chips and **See it run** (real screenshots of
  their own site), one harvested-oracle hardening offer, one unproven signup in
  "Needs a decision". One click adds 4 tests to the suite.

### 3.2 Steady state
Re-analysis from the suite toolbar; last settings remembered; `auto` mode skips
the checkpoint; dedup drops what the suite already covers; delivery banner over
the tests list; App Brief moves to v2. Old accepted tests untouched.

---

## 4. Screens (wireframes)

### 4.1 Empty-state hero (zero cases only)
```
┌────────────────────────────────────────────────────────────────────┐
│                              ✦                                     │
│                Your suite is empty. Kaizen isn't.                  │
│   Point Kaizen at your app. It explores it like a QA engineer      │
│   on day one, writes a test plan for your approval, and proves     │
│   every test with a real run — before you accept a single one.     │
│         [ ✦  Analyze my app ]      [ Write a test yourself ]       │
│   Takes a few minutes · read-only exploration · you approve the    │
│   plan before anything is executed                                 │
└────────────────────────────────────────────────────────────────────┘
```
If the workspace has no suites, the sheet creates one inline.

### 4.2 AnalyzeSheet (Sheet, width 580)
```
┌──────────────────── Analyze an app ─────────────────────────┐
│  Kaizen explores it read-only, shows you a test plan, and    │
│  writes only what you approve.                               │
│  Suite         [ Checkout ▾ ]  (+ new)                       │
│  App URL       [ https://staging.acme.shop            ]      │
│                ⓘ Use a staging URL if you have one…          │
│  Describe your app — optional, but it makes the plan sharper │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ What it does, the flows that matter, business rules…   │  │
│  └────────────────────────────────────────────────────────┘  │
│  Don't paste credentials — they're detected and removed.     │
│  ┌─ What Kaizen may do on your site ──────────────────────┐  │
│  │ [ ] Allow tests that create throwaway data             │  │
│  │     Off: signup & cart tests are still written, but    │  │
│  │     proposed unproven instead of executed.             │  │
│  │  ▸ What exploration does — and never does              │  │
│  └────────────────────────────────────────────────────────┘  │
│  ▸ Advanced                                                  │
│  │  Exploration depth ( Quick 10 | Standard 30 | Deep 50 )   │
│  │  Tests to plan [ 6 ]                                      │
│  │  Pause for my approval after planning   [on ●———]         │
│  │  Prove each test with a real run        [on ●———]         │
│  │  Signed-in exploration    soon                            │
│  Standard depth usually takes 2–5 minutes and well under      │
│  50k tokens of your budget.                                   │
│                       [ Cancel ]   [ ✦ Start exploring ]     │
└──────────────────────────────────────────────────────────────┘
```
- URL prefills from the suite's common `baseUrl` or last job. Soft staging
  notice when the host looks production-like (never blocking).
- Consent writes `allowSyntheticData`; the consequence sentence flips with state.
- **safeMode is NOT exposed** — no "disable the seatbelt" toggle on a first-run form.
- Submit → `202 {jobId, warnings[]}` → `go('writer', …)`; warnings render as a
  banner + toast. Errors inline: 402 with used/budget, 404, active-job conflict.

### 4.3 PROGRESS face
```
Toolbar: [←] QA Engineer — Checkout     staging.acme.shop · started 2m ago
┌─ card ──────────────────────────────────────────────────────────────────┐
│   ●━━━━━━━━━━━○──────○──────◇──────○──────○                             │
│   EXPLORE   UNDERSTAND   PLAN   ⏸ YOU   WRITE   PROVE                   │
│   ◔ Exploring — 12 pages so far                                  02:11  │
│   Visiting up to 30 pages at about one per second. Reading only:        │
│   no form is ever submitted, no button that changes data is pressed.    │
│   ✓ Explore    12 pages · 31 safe probes · 1 page blocked               │
│   ◔ Understand …                                                        │
│   ◇ Your approval                                                       │
│   ○ Write      only what you approve                                    │
│   ○ Prove      each test runs for real before you see it                │
└─────────────────────────────────────────────────────────────────────────┘
│ You can leave — this keeps running. We'll flag the sidebar and the tab. │
```
**Honesty constraint**: live per-phase counts need `report.progress` (§11.0-d).
Without it, phases before PLAN show one active segment with elapsed time only —
never invented counts. No cancel button in v1 (no endpoint); the job self-bounds.

### 4.4 PLAN REVIEW face (the trust-winning screen)
```
┌─ what Kaizen understood ────────────────────────────────────────────────┐
│ ✦ E-commerce storefront                                    App Brief ▸ │
│ "Acme Shop sells apparel; visitors browse, search, and buy via a       │
│  3-step checkout."                                                     │
│ 14 pages · 3 verified journeys · Browse→Detail→Cart · Search · Signup  │
│ ⚠ 1 place you described that the crawl never reached:                  │
│   "checkout payment" — likely behind sign-in.             details ▸    │
└─────────────────────────────────────────────────────────────────────────┘
  THE PLAN — 6 scenarios · nothing has been executed yet
┌─ list ──────────────────────────────────────────────────────────────────┐
│ [x] Add a product to the cart from the listing                          │
│      HAPPY · CRITICAL · CATALOG                     /products, /cart    │
│      Why: the shortest path to revenue — if this breaks, everything     │
│      downstream is theater.            ⚠ creates throwaway cart data   │
│ [x] Search finds a product that exists                                  │
│      HAPPY · HIGH · CATALOG                                             │
│      Why: grounded to "Aurora Hoodie" — an item the crawl proved        │
│      exists, so this can't pass vacuously.                              │
│ [x] Visiting /account while signed out lands on login                   │
│      NEGATIVE · CRITICAL · CATALOG                                      │
│      Why: the access-control test human suites chronically skip.        │
│ [ ] Newsletter signup confirms subscription                             │
│      HAPPY · NORMAL · AI    ⚠ needs data consent — currently off       │
└─────────────────────────────────────────────────────────────────────────┘
  Steering notes — optional, applies to the whole batch
┌─────────────────────────────────────────────────────────────────────────┐
│ 2 selected tests create throwaway data and consent is off — they'll be │
│ written but not proven.        [ Allow throwaway data on this suite ]  │
│   [ Discard plan ]                [ ✦ Write & prove 5 tests ]           │
│     ≈2–4 min · real runs against staging.acme.shop · ~15–30k tokens    │
└─────────────────────────────────────────────────────────────────────────┘
```
- Rows `.row.focus-row`; all checked by default; unchecked drop to 55% opacity
  but keep position — the user should see what they're declining.
- Source chips: `CATALOG` (tooltip: *"From Kaizen's curated pattern library — a
  proven test shape, bound to your app's real pages"*) / `AI ⓘ` (*"Written
  specifically for this app — no library pattern covered it"*).
- **The economics line under the CTA is mandatory copy** — the honest
  counterweight to a one-click approval.
- CTA → `POST /testwriter/jobs/:id/plan-approval {approvedScenarios, notes}`.
  409 → refetch and render current face.
- Discard → `approvedScenarios: []` (needs §11.0-f).
- In `auto` mode the same matrix renders read-only inside PROGRESS.

### 4.5 DELIVERY face
```
┌─ stat strip ────────────────────────────────────────────────────────────┐
│  4 PROVEN      1 UNPROVEN       2 REJECTED      31k TOKENS              │
└─────────────────────────────────────────────────────────────────────────┘
┌─ accept bar ────────────────────────────────────────────────────────────┐
│  Every proven test below ran green against your site.                   │
│  [ ✓ Add all 4 to the suite ]        or review them one by one below   │
└─────────────────────────────────────────────────────────────────────────┘
┌─ PROVEN ────────────────────────────────────────────────────────────────┐
│ ✦ Add a product to the cart from the listing        ● PROVEN            │
│    6 steps · happy                     [See it run] [Edit] [✓] [✕]      │
│ ✦ Search for nonsense shows the no-results state    ● PROVEN            │
│    Kaizen asserted "the no-results message is visible" and observed:    │
│    "No results for 'zzqx…'"                                             │
│    [ Use the observed text as the assertion ]                           │
│ ✦ Coupon field rejects an invalid code            ◐ PROVEN, SELF-HEALED │
│    The proof run healed a selector on step 4 — worth a look.            │
└─────────────────────────────────────────────────────────────────────────┘
┌─ NEEDS A DECISION ──────────────────────────────────────────────────────┐
│ ✦ Sign up with a new account                      ⚠ UNPROVEN            │
│    Would create a real account, and throwaway data is off.              │
│    [Allow throwaway data]        [Accept unproven] [✕ Dismiss]          │
└─────────────────────────────────────────────────────────────────────────┘
 ▸ 2 scenarios were rejected — Kaizen shows its work
 ▸ Coverage gaps & dropped journeys (2)
 ▸ What Kaizen did on your site — 14 pages read · 31 safe probes ·
    0 mutating actions during exploration · 5 proving runs · consent OFF
```
- Accept-all fires parallel `PATCH /cases/:id {status:'active'}`; optimistic flip
  with per-row **Undo** for 10s; toast *"4 tests added to Checkout."*
- Dismissed rows stay listed, struck, with **Restore**.
- Harvest hardening PATCHes the case's steps (normal edit → new step version);
  UI notes *"edited after proof — the proof run shows the original step"*.

### 4.6 Job history strip
`.list` of the suite's jobs (`GET /suites/:id/jobs`) at the bottom of every
Writer face: date, status, target host, `n proposed / m accepted`. Append-only —
the durable audit surface.

### 4.7 Tests list integration
```
│ ✦ Add a product to the cart from the listing   DRAFT   —    —   never  │
│    staging.acme.shop · Kaizen                  [✓ Accept] [Proof] [⋯]  │
│ Search finds a product that exists              82%  free  ● Passed 2m │
```
- Draft rows: `DRAFT` badge, author "Kaizen", Run replaced by **Accept**
  (a draft can't run from here — the affordance teaches why).
- `validating`: `PROVING` badge + spinner, actions disabled.
- Accepted generated tests keep a small ✦ forever (tooltip: *"Written by Kaizen ·
  proven <date> · accepted by you"*).
- `Drafts` filter option appears only when drafts exist.
- Delivery banner when the latest job has unaccepted drafts or awaits approval.

### 4.8 App Brief card (durable artifact)
```
▾ ✦ What Kaizen knows about this app                    v2 · crawled 2d ago
│  E-commerce storefront — "Acme Shop sells apparel…"
│  Entities: product · cart · order · account
│  Journeys (verified against the real link graph):
│    ● CRITICAL  Purchase   / → /products → /product/* → /cart
│    ● HIGH      Search     / → /search
│  14 pages known · 1 blocked by anti-bot            [ Re-analyze ▸ ]
```
Journey tooltip: *"Every hop in this path was observed as a real link by the
crawler."* Version history via a `v2 ▾` menu (briefs are versioned by design).

### 4.9 RunScreen provenance banner
```
│ ✦ This is a proving run — Kaizen executed this draft to earn the right  │
│   to propose it. It doesn't appear in your Runs feed.    [To the draft] │
```

### 4.10 HALTED faces
```
│  ⃠  Kaizen couldn't get in                                              │
│  staging.acme.shop answered with an anti-bot challenge on every page.  │
│  Kaizen never tries to defeat these — it's your site's call.           │
│                                    [ Close ]  [ Try a different URL ]  │
```

---

## 5. State model

### 5.1 Job states
```
queued ─▶ running ─┬─▶ awaiting_plan_approval ─▶ (approval) ─▶ running ─▶ completed
                   │                          └▶ (7-day timeout*) ─▶ failed
                   ├─▶ completed (+error "No scenarios could be planned.")
                   ├─▶ failed
                   └─▶ blocked
   discard: plan-approval [] ─▶ completed (+error "No scenarios were approved.")
```
\* specced but **no sweeper exists yet**; the UI treats an `awaiting_plan_approval`
job older than 7 days as expired client-side regardless.

| Condition | Face |
|---|---|
| `queued` | PROGRESS ("waiting for a writer worker") |
| `running`, `testPlan == null` | PROGRESS phases 1–3 |
| `awaiting_plan_approval` | PLAN REVIEW |
| `running`, `testPlan != null` | PROGRESS phases 4–5 |
| `completed`, no error | DELIVERY |
| `completed` + "No scenarios could be planned." | HALTED-empty (App Brief still shown) |
| `completed` + "No scenarios were approved." | HALTED-closed |
| `failed` / `blocked` / poll 404 | HALTED-failed / -blocked / -gone |

### 5.2 Case states
```
(writer) validating ──▶ draft ──accept──▶ active ──dismiss/undo──▶ archived
              │            └──dismiss──▶ archived ──restore──▶ draft
              └──proof failed──▶ rejected (report-only)
user-created: born active, origin='user'
```

| status | Tests list | Delivery | Runnable | Actions |
|---|---|---|---|---|
| `validating` | PROVING spinner | in-flight | no | open writer |
| `draft` + run | DRAFT badge | PROVEN | no | Accept · See it run · Edit · Dismiss |
| `draft`, run healed | DRAFT + heal chip | PROVEN, SELF-HEALED | no | + nudge |
| `draft`, no run | DRAFT + UNPROVEN amber | NEEDS A DECISION | no | Accept unproven · consent · Dismiss |
| `draft`, tier-2 | DRAFT + EXPECTED-FAIL | NEEDS A DECISION | no | review-only |
| `active`, generated | ✦ mark | IN SUITE ✓ | yes | normal |
| `rejected` | hidden | rejection disclosure | no | Dismiss |
| `archived` | hidden | struck + Restore | no | Restore |

---

## 6. Async & notification design

### 6.1 `useActiveGenerationJobs` (app-level)
- Discovery: fan out `GET /suites/:id/jobs` on mount (the `use-all-cases` pattern).
- Polling: `queued|running` every 2s (the `use-run-poller` cadence);
  `awaiting_plan_approval` every 10s. Terminal jobs stop. Idle workspace = zero requests.
- Transitions → toasts: `→awaiting_plan_approval` *"Test plan ready — Kaizen is
  waiting for you"*; `→completed` *"N tests proposed — every one proven with a
  real run"*; `→failed|blocked` error toast. Toasts route to the writer screen.
- **Document title** is the away-tab channel: `● Plan ready — Kaizen` /
  `◔ Exploring… — Kaizen`. No notification permissions; works everywhere.

### 6.2 Persistent affordances
```
┌──────────────────────────┐
│ ✦ QA engineer            │
│ ◔ Checkout — exploring   │
│ ◇ Smoke — plan ready     │   (pulsing)
└──────────────────────────┘
```
Sidebar chip + per-suite pulsing dot + tests-list delivery banner. All derived
from DB rows on mount — nothing lives only in memory. Accepted loss: the
analyze response's `warnings[]` are session-only.

### 6.3 Latency honesty
Never a percent bar for the whole job (unknowable denominator). Elapsed time
always; counts only when real; the rail communicates sequence, the copy
communicates scale. The 20-minute crawl ceiling bounds the worst case.

---

## 7. Copy (canonical strings)

**Analyze sheet** — title `Analyze an app`; sub `Kaizen explores it read-only,
shows you a test plan, and writes only what you approve.`
URL hint: `Use a staging URL if you have one. Kaizen never mutates data without
your say-so, but proving tests means really running them.`
Production notice: `This looks like a production URL. Exploration is read-only,
and nothing that creates data runs without the consent box below — but proofs
are real runs. A staging environment is the calmer choice.`
Brief placeholder: `What it does, the flows that matter, business rules, what to
test hardest. e.g. "B2C shop. Checkout is revenue-critical. Coupons ship next
week — hit search and cart hard. Never touch /admin."`
Brief hint: `Don't paste credentials — they're detected and removed.`
Consent (off): `Off: signup and cart tests are still written, but proposed
unproven instead of executed.`
Consent (on): `Kaizen may create unique per-run records — accounts like
kaizen+8f31@…, cart items, form submissions — while proving tests on this suite.
Recorded on every job for audit.`
Expectations: `Standard depth usually takes 2–5 minutes and well under 50k
tokens of your budget. Deep scans can take up to 20 minutes.`

**"What exploration does — and never does"**: `Kaizen visits your pages the way a
careful QA engineer would on day one: it follows links, opens menus, tabs and
dialogs, and reads forms — it never submits them. It obeys robots.txt, stays on
your domain, visits about one page per second, and stops at the page cap.
Buttons that could change data — delete, pay, publish, save — are classified and
never pressed. Checkout tests walk up to the payment step and stop. Everything
it does is recorded on the job. Proving a test is different: that's a real run of
the finished test, and anything that would create data first needs the consent
box above.`

**Secret scrub**: `Removed a suspected secret from your description ({kinds}).
Kaizen never needs credentials in the brief.`

**Progress**: recon `Exploring — {n} pages so far` / `Visiting up to {cap} pages
at about one per second. Reading only: no form is ever submitted, no button that
changes data is pressed.`; understand `Working out what each page is for, and how
a user moves through the app.`; plan `Choosing what a QA engineer would test
first — and why.`; write `Writing steps that reference only elements the crawl
actually saw.`; prove `Running each test for real. Only green survivors are
proposed.`; leave-line `You can leave — this keeps running. We'll flag the
sidebar and the tab title when it's your turn.`

**Plan review**: header `Kaizen has a plan. Nothing has been executed yet.`;
coverage gap `You described "{flow}" — the crawl never reached it. Likely behind
sign-in; signed-in exploration is coming.`; steering placeholder `Anything to
steer by? e.g. "skip newsletter tests; assert cart totals, not just item names"`;
consent bar `{n} selected tests create throwaway data and consent is off —
they'll be written but not proven.`; CTA `✦ Write & prove {n} tests` / sub
`≈2–4 min · real runs against {host} · nothing runs that you didn't approve`;
discard confirm `The exploration and the App Brief are kept. No tests will be
written from this plan.`

**Delivery**: accept bar `Every proven test below ran green against your site.` /
`✓ Add all {n} to the suite`; harvest `Kaizen asserted "{generic}" and observed:
"{harvested}"` / `Use the observed text as the assertion`; healed `The proof run
healed a selector on step {n} — worth a look before you accept.`; unproven
`Would create a real account, and throwaway data is off for this suite. Accept it
unproven, or allow throwaway data — the next analysis will prove it.`;
expected-fail `This test passes by failing at step {n}. Kaizen can't yet run
expected-failure tests in a suite, so it's review-only.`; toast `{n} tests added
to {suite}.`

**Rejection reasons by stage**:
- `safety`: `Skipped for safety — it would have pressed "{element}", which can change real data.`
- `schema`: `Referenced an element the crawl never saw. Rather than guess, Kaizen dropped it.`
- `render`/`compile`: `Couldn't be expressed as runnable steps.`
- `dedup`: `You already have this covered — duplicate of "{name}".`
- `judge` D1: `Its assertion would pass before the test did anything — it couldn't fail, so it proves nothing.`
- `judge` D2: `A negative test must break exactly one rule and assert the rejection it causes; this one didn't.`
- `judge` D3: `More page-poking than a real user task — a crawler's job, not a test.`
- `judge` D4: `Adds nothing the batch doesn't already cover.`
- `validation`: `Failed its proving run at step {n}.` + `See the run`
- `consent`: `Needs permission to create throwaway data before it can be proven.`
- Header: `{n} scenarios were rejected — Kaizen shows its work.`

**Halted**: robots `robots.txt asks crawlers to stay out of this site, and Kaizen
honors that. If this is your staging environment, allow it for Kaizen's user
agent and run the analysis again.`; no-scenarios `Kaizen explored {n} pages but
couldn't plan a single defensible test — usually a very small site, or one whose
real flows sit behind sign-in. It did produce an App Brief (below).`;
all-rejected `Kaizen wrote {n} tests and rejected all of them rather than propose
something weak.`; failed `Something broke mid-job: {error}. Nothing was left
half-done — drafts only appear after a green proof.`; expired `This plan waited
more than 7 days, and the site has probably drifted from what was explored.`;
402 `This workspace has used {used} of {budget} tokens this month.`;
concurrent `An analysis is already running for this suite. One at a time keeps
the site knowledge coherent.`

---

## 8. Trust & safety UX

1. **Consent is specific, situated, consequence-stated** — names concrete
   artifacts, lives at the decision moment (not a settings page a habit can
   pre-click), defaults off, states the consequence of BOTH states, and is
   recorded per job (the delivery audit shows consent *as it was at run time*).
2. **The standing contract is an expandable, never an interstitial** —
   dismissible modals train dismissal; disclosures can be re-read forever.
3. **Staging is recommended, never required** — a blocking rule would be
   dishonest theater (Kaizen can't verify environment).
4. **The audit trail is a product surface, not a log** — "What Kaizen did on your
   site" converts the scariest fact ("a robot walked my production site") into
   the most reassuring one ("here is everything it touched").
5. **Provenance never fades** — accepted generated tests keep the ✦ mark and
   their `generation_job_id`/`validation_run_id` chain.
6. **Untrusted text stays text** — scenario names, rationales and harvested
   strings render as plain text; never `dangerouslySetInnerHTML`.

---

## 9. Edge cases

1. **Re-analysis**: new jobs never delete anything; dedup prevents re-proposing
   what exists. Unaccepted older drafts stay in the list. Proof age is visible
   (`proven {date}`); nothing auto-expires in v1. App Brief bumps a version.
2. **Nothing planned**: HALTED-empty with the App Brief still shown — real value
   was produced — plus three concrete next moves.
3. **All rejected**: rejection-with-reasons presented as integrity, not failure.
4. **Blocked**: challenge vs robots copy split; "Try a different URL" reopens the
   sheet prefilled.
5. **Concurrent jobs**: the API doesn't prevent them, so the UI does — `✦ Analyze`
   becomes `View progress` while a job is live for that suite.
6. **Large plans**: capped at 10 scenarios; target pages truncate to 2 + `+n`.
7. **Narrow viewport**: plan rows stack; action clusters collapse into `⋯`;
   nothing that a decision depends on is hidden — only metadata drops.
8. **Suite deleted mid-job**: poll 404 → HALTED-gone.
9. **Approval raced from another tab**: 409 → refetch and render.
10. **Budget exhausted**: 402 at the sheet with real numbers.
11. **Healed proof**: still PROVEN (healed = passed), with a look-before-accepting nudge.

---

## 10. Component inventory

**Reused**: `Toolbar`, `Seg`, `Stat`, `Ring`, `Sparkline`, `Menu`, `Sheet`,
`ConfirmSheet`, `Disclose`, `Switch`, `Toast` (+`onClick`), `CountUp`,
`StatusBadge`/`StatusDot`, `SourceTag`, and the `aperture.css` utilities.

**New** (all under `components/design/`):

| File | Contents |
|---|---|
| `screen-writer.tsx` | face switch, `PhaseRail`, `PlanRow`, `DraftRow`, `RejectionRow`, stat strip, history strip, halted states |
| `writer-analyze-sheet.tsx` | the entry dialog |
| `writer-bits.tsx` | `DraftBadge`, `KindChip`, `SourceChip`, `ConsentChip`, `DeliveryBanner`, `SidebarActivityChip` |
| `app-brief-card.tsx` | App Brief + journey rows + version menu |
| `hooks/use-generation-job.ts` | single-job poller |
| `hooks/use-suite-jobs.ts` | job history |
| `hooks/use-active-generation-jobs.ts` | app-level registry + toasts + title |
| `types/api.ts` | `GenerationJob*`, `PlannedScenario`, `ScenarioRejection`, `OracleHarvest`, `CaseStatus`, `CaseOrigin`; `CaseSummary += status, origin, validationRunId, generationJobId, archetypeKey`; `Suite += allowSyntheticData`; `RunSummary.triggeredBy += 'testwriter'` |

**Deliberately not built**: a separate drafts screen (violates the same-list
decision); a notifications center; plan editing beyond include/exclude + notes
(editing scenarios pre-write invites specifying tests the crawl can't ground).

---

## 11. Implementation plan

### 11.0 Backend prerequisites (small, existing files — the UI cannot ship without these)

a. **Expose case lifecycle** — `src/api/routes/test-cases.ts`: add `status,
   origin, validation_run_id, generation_job_id, archetype_key` to the list and
   detail SELECTs + `mapCaseSummary`; add a `?status=` filter. *Today the UI
   cannot distinguish a draft from an active test at all.*
b. **Status transitions** — `UpdateCaseBody += status`; allow
   `draft→active|archived`, `active→archived`, `archived→draft`,
   `rejected→archived`; everything else 400.
c. **Run guard** — `POST /cases/:caseId/run` returns 400 `CASE_NOT_ACTIVE` for
   non-active cases (currently unchecked).
d. **Progress + token visibility** — write `report.progress {phase, pagesCrawled,
   validationRunsDone/Total}` at phase boundaries and every ~3 pages; add
   `report.tokenUsage` per phase.
e. **Suite consent surface** — return `allow_synthetic_data`;
   `UpdateSuiteBody += allowSyntheticData`.
f. **Discard plan** — `approvedScenarios: min(0)`, and guard the resume path so
   an explicit empty array means "none" rather than falling back to "all".
g. **App Brief endpoint** — `GET /suites/:suiteId/app-brief` (+ `?version=`).
h. **Runs-feed exclusion** — `GET /runs` must exclude `triggered_by='testwriter'`
   (locked product decision, **not yet implemented**); keep by-id reachable.
i. *(rung 3, later)* `suites.auto_accept_validated`; the 7-day
   `plan_approval_timeout` sweeper (also unimplemented).

### 11.1 Web foundation
1. `types/api.ts` additions. 2. the three hooks. 3. `kaizen-app.tsx` writer screen
+ active-jobs hook + toasts + title; `chrome.tsx` activity chip.

### 11.2 ★ Demoable slice (empty suite → analyze → plan → delivery)
4. AnalyzeSheet. 5. PROGRESS face. 6. PLAN REVIEW face. 7. DELIVERY v1
(accept-all/one, rejections, stat strip). 8. Empty-state hero + `✦ Analyze`.
*This slice alone performs §3.1 end-to-end.*

### 11.3 List integration & evidence
9. Draft badges + row actions + Drafts filter + delivery banner.
10. RunScreen proof banner. 11. Harvest hardening; healed/unproven/tier-2 states.

### 11.4 Knowledge & history
12. App Brief card + job history strip. 13. Coverage gaps, audit disclosure,
tokens-per-phase.

### 11.5 Hardening & ladder
14. HALTED faces, concurrent guard, narrow viewport. 15. Remembered options;
rung-3 groundwork. 16. Web tests: face selection per §5.1 row, approve/discard,
accept/undo, consent-gated states.

### 11.6 Mission 1 remainder (2026-08-17)

Everything below is what §0.0 marks not built, specified to implementation
depth. Signed-in exploration is specified in `../test-writer/spec-authenticated-scope.md`
§11 and Suggest in `../test-writer/spec-scoped-suggest.md`; the rest is here.

**a. The PLAN segment must light up.** `pipeline.ts` writes `progress` for
`recon`, `comprehend`, `write` and `validate` — never `plan`. So a job sits
visibly on UNDERSTAND while it is planning, which for a slow LLM plan is the
longest single stretch of the wait, and the one segment of the rail that never
activates is the one immediately before the user's turn. Add
`await progress({ phase: 'plan' })` before `planner.plan()`. One line; it is
listed here because it reads as cosmetic and is not — the rail is the only
honest signal the user has, and a segment that never lights teaches them the
rail is decorative.

**b. The away-from-screen channel (§6.1, §6.2).** The premise of the PROGRESS
face is *"you can leave — we'll flag the sidebar and the tab title"*, and today
that promise is not kept: there is no title change, no sidebar chip, and no
transition toast. Copy that promises a notification the product does not send
is worse than no copy.

What exists is `kaizen-app.tsx`'s `scanJobs`/`pendingDelivery` — a fan-out over
`GET /suites/:id/jobs` on mount, polled at 4s while something is in flight,
feeding the tests-screen delivery banner. That is the right foundation and is
**not** to be replaced by the `useActiveGenerationJobs` hook §6.1 imagined;
extract it into `hooks/use-active-generation-jobs.ts` with its behaviour intact
and add three outputs:

- **Document title** — `● Plan ready — Kaizen` when any job awaits approval,
  `◔ Exploring… — Kaizen` while any job runs, restored on idle. Restoration
  must be in the effect's cleanup, or a user who navigates away from an active
  job keeps a stale title forever.
- **Sidebar activity chip** (`chrome.tsx`) — one row per live job, suite name
  plus state, clicking routes to that writer screen; a pulsing dot on the suite
  row. Derived from the same scan, so a reload rebuilds it from the API.
- **Transition toasts** — fired on observed status *change*, never on first
  observation. A toast on mount would announce a plan the user approved
  yesterday every time they open the app. The hook already tracks previous
  status per job for the banner; the toast rides the same comparison, and jobs
  first seen in a terminal state are seeded silently.

Polling stays as it is: 4s while in flight, nothing when idle. Do not lower it
for the title's benefit.

**c. Deselection provenance (§4.4).** The plan screen sends `approvedScenarios`
and the declined ones vanish — no record that a human looked at a scenario and
said no. That is a hole in an audit surface the product otherwise takes
seriously, and it is the raw material for the obvious future behaviour ("stop
proposing this").

`POST /testwriter/jobs/:jobId/plan-approval` already computes the approved set
against `test_plan.scenarios`; the complement is free. Persist it into the job
report as `report.plan.declined: [{ name, reason: 'user_deselected' }]` — the
same shape as the existing `report.plan.dropped`, so the delivery face's
disclosure renders both with one component. Recorded as a `reason`-bearing row
rather than a bare name list so a later "why" (a per-row note, a rejection
category) has somewhere to go without a shape change.

The delivery face gains one line in the rejection disclosure: *"{n} scenarios
you declined"* — shown, never hidden, because §4.4's design law is that the user
should see what they declined.

**d. Findings on the halted and blocked faces.** `spec-findings-and-coverage.md`
§0's rule is *a job must never return nothing*, and the pipeline honours it: a
job blocked at sign-in or by robots still writes `report.findings` before it
stops (`pipeline.ts` `earlyFindings`). `HaltedFace` renders none of them. So the
one path where the user has *least* to show for their spend is the one path that
shows them nothing — the exact failure the findings spec was written to close.
`HaltedFace` renders `<FindingsSection>` beneath its message, unchanged.

**e. Coverage gets a face.** Specified in
`../test-writer/spec-findings-and-coverage.md` §3.1 (amended 2026-08-17).

---

## Design judgments worth restating

- **Gate before the irreversible, undo after it** — why draft review survives as
  a one-click acceptance rather than dying or staying a queue.
- **The plan screen sells *why*, not *what*** — rationales, grounded details, and
  provenance are the trust payload; the checkbox is almost incidental.
- **Rejections are marketing** — "Kaizen refused to propose this, and here's why"
  demonstrates the quality bar better than any accepted test.
- **Honesty over theater** — no fake progress, no invented counts, no "free"
  until measured. This repo already lives that rule; the feature whose entire
  premise is *proof* must too.
