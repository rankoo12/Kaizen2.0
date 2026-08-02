# Spec: Native macOS/iOS Redesign — full UI replacement

Created: 2026-07-30

## 1. Context

The user produced a new design with Claude Design (delivered under `Kaizen (1)/`, the
`native/` variant; `Kaizen.html` is its entry). It is a **complete replacement** for the
current "nebula" dark web UI (the `prototype/` variant + `spec-prototype-port.md`), NOT a
refinement. The new direction is a **macOS/iOS native desktop app**:

- Light appearance by default, dark as a flip (`data-appearance="light|dark"`).
- One blue accent (`#0b62f4`), Apple system type, hairline separators, two materials
  (window chrome / content), macOS shadows and radii.
- macOS chrome: a menu bar (File/Test/View/Help with ⌘ shortcuts), traffic-light window
  controls, a vibrancy sidebar, and a unified toolbar per screen.
- Richer screen set than today, including two screens the current app lacks: **The Brain**
  (every learned element, confidence, scope, cost saved) and **Runs** (run history feed),
  plus **Usage/Settings**.

Source of truth for visuals: `Kaizen (1)/native/*` — `tokens.css` (design system),
`chrome.jsx` (shell + shared primitives), and one `screen-*.jsx` per screen. Read-only.

## 2. Goals

- Replace the entire production UI with the native design, faithfully.
- Preserve all data flows: `useSuites`, `useCases`, `useCaseDetail`, `useRunPoller`,
  `/api/proxy/*`, `AuthContext`. No backend/route/hook changes.
- Switch the theme mechanism from `data-theme` (nebula/deep-space/solar-flare) to
  `data-appearance` (light/dark). Light is the default.
- Keep the `<Wip />` convention: any slot the backend does not expose renders `WIP`, never
  faked. Carry over the existing WIP inventory.

## 3. Non-goals

- No backend changes, no new API contracts, no new hooks.
- The prototype's developer `tweaks-panel` is not ported.
- The iPhone (`device: phone`) mode and the literal window-minimise/dock behaviour are
  cosmetic extras — ported only if cheap; not required for v1.

## 4. Design tokens

Port `native/tokens.css` into `packages/web/src/app/globals.css`, replacing the nebula
token set. Names stay as the design authored them (`--accent`, `--text`, `--pass`,
`--window`, `--content`, `--sep`, `--shadow-1..3`, `--r-win/card/ctl`, etc.), defined on
`:root` (light) and re-defined under `[data-appearance="dark"]`. Expose the handful used as
Tailwind utilities through `@theme`; the design's own component classes (below) live in
globals.css as the base layer (same precedent the current globals.css already sets with
`.chip`, `.btn`, `.starfield`).

## 5. Component / class inventory (from tokens.css + chrome.jsx)

Base classes to bring over verbatim (adapted to the token names): `.win`, `.lights`,
`.light`, `.toolbar`, `.sidebar`, `.side-item`, `.side-label`, `.side-count`, `.btn`
(+`.pri/.ghost/.danger/.lg/.icon`), `.seg`, `.switch`, `.field`, `.label`, `.card`,
`.list`, `.list-h`, `.row`, `.badge`, `.pill`, `.mono-chip`, `.dot`, `.meter`, `.spinner`,
`.menubar`, `.mb-item`, `.popover`, `.menu-item`, `.sheet`, `.scrim`, `.toast`, `.dock`,
`.shot` (faux evidence), `.highlight`, plus keyframes (heal-flash, strike, spin, pulse,
rise, toast-in, sheet-in, pop). `prefers-reduced-motion` disables the infinite ones.

Shared React primitives (port `chrome.jsx` → atoms/molecules): `Seg`, `Switch`, `Toolbar`,
`Lights`, `MenuBar`, `Menu`, `Sidebar`, `Sheet`, `ConfirmSheet`, `Toast`, `Stat`,
`Sparkline`, `Ring`, `SourceTag`, `FauxShot`, `Disclose`.

## 6. Layout / shell

`(app)/layout.tsx` becomes the macOS window: MenuBar on the wallpaper, then the `.win`
frame containing Sidebar + a per-screen `<main>` (Toolbar + content). The old
`app-shell/{side-rail,top-bar,shell-background}` are replaced (archived to `.old/`).
Wallpaper + window shadow come from the tokens.

## 7. Screen port map

| New design (native) | Production target | Data |
|---|---|---|
| `screen-tests.jsx` | `organisms/tests-dashboard.tsx` (rewrite) | `useSuites` + `useCases`; health cards from aggregates (trend numbers = `<Wip/>`) |
| `screen-run.jsx` | `organisms/test-detail-screen.tsx` (rewrite) | `useCaseDetail` + `useRunPoller`; timeline/step-inspector from `step_results`; self-heal trace + per-step tokens = real if present else `<Wip/>` |
| `screen-author.jsx` | `organisms/new-test-screen.tsx` (rewrite) | existing create flow (`/suites/:id/cases`, `/cases/:id/run`) |
| `screen-brain.jsx` | `organisms/brain-screen.tsx` (NEW) + route `(app)/brain` | needs a read of `selector_cache` via proxy; if no endpoint, whole screen behind `<Wip/>` with a clear empty state (flag: may need a small read-only API) |
| `screen-runs.jsx` | `organisms/runs-screen.tsx` (NEW) + route `(app)/runs` | run feed; if no list endpoint, `<Wip/>` |
| `screen-settings.jsx` | `organisms/settings-screen.tsx` (NEW) + route `(app)/usage` | appearance/density toggles (local); usage from billing if exposed else `<Wip/>` |
| `screen-mobile.jsx` | deferred | — |
| `auth-screens` (login in app.jsx) | refresh `login-form`/`signup-form`/`welcome` | logic unchanged |

## 8. Theme system change

`context/theme-context.tsx` + `atoms/theme-script.tsx` + `molecules/theme-switcher.tsx`
move from `data-theme` (three nebula themes) to `data-appearance` (`light`/`dark`), default
`light`, persisted. Update the no-flash inline script accordingly.

## 9. Tailwind / conventions

Per `docs/CLAUDE.md`: prefer Tailwind utilities; the design's base component classes and
keyframes live in globals.css (allowed base layer). `cn()` on every className. No `.js`.
No `any` without justification. Atomic-design split for the ported primitives.

## 10. Sequencing (each stage ends with `npm run typecheck && npm run lint` clean; render-verify per stage)

1. **Tokens + base** → new `globals.css` (macOS system) + theme system → `data-appearance`.
2. **Shell + primitives** → `(app)/layout.tsx` (menu bar, window, sidebar, toolbar) + the
   `chrome.jsx` primitives as atoms/molecules. Old shell → `.old/`.
3. **Tests dashboard** (health cards + grouped inset list).
4. **Run detail** (summary strip, history, timeline/step inspector, evidence shots).
5. **Author / New test**.
6. **The Brain** + **Runs** + **Usage** (new routes; behind `<Wip/>` where no endpoint).
7. **Auth refresh** (login/signup/welcome).
8. **Cleanup**: delete all `.old/`; drop the nebula token spec (`spec-prototype-port.md`
   marked superseded).

## 11. Open item

The Brain and Runs screens read data the current API may not expose (a `selector_cache`
read; a per-tenant run list). Where an endpoint is missing, the screen renders its full
layout with `<Wip/>` in the data slots rather than being skipped — same rule as everywhere
else. A thin read-only endpoint can be added later if we want them live.

---

## 12. As-built (Updated: 2026-07-30)

The port landed as a single self-contained module rather than per-route organisms: the
design owns its own navigation, so `(app)/layout.tsx` renders one `KaizenApp` and the
per-route pages are no longer used. All ported code lives in
`packages/web/src/components/design/`:

| File | What it is |
|---|---|
| `icons.tsx`, `chrome.tsx`, `data.ts` | verbatim ports of the design's icon set, shell primitives, and `fmt`/`SOURCES` helpers |
| `kaizen-app.tsx` | orchestrator: menu bar, sidebar, screen switching, ⌘N/⌘1–4, appearance + grouping (localStorage) |
| `use-design-data.ts` | maps real API shapes to the shapes the screens expect |
| `screen-tests.tsx`, `screen-author.tsx`, `screen-run.tsx`, `screen-runs.tsx`, `screen-brain.tsx`, `screen-usage.tsx` | the six screens, all on live data |

### What each screen reads

| Screen | Real source |
|---|---|
| Tests | `useSuites` + `useAllCases`; health cards derived from real run statuses; "from memory" = share of last runs that cost 0 tokens |
| New test | `POST /suites` (inline suite create), `POST /suites/:id/cases`, `POST /cases/:id/run` |
| Run detail | `useCaseDetail` + `useRunDetail` (2s poll while non-terminal); evidence from `/media?key=`; verdicts via `PATCH /runs/:id/steps/:id/verdict`; history from `recentRuns` |
| Runs | `GET /runs` (4s refresh while anything is queued/running) |
| The Brain | `GET /brain/selectors` (new, below) |
| Usage | `GET /tenants/:id/usage`, `GET /tenants/:id/members`, `GET /runs`; `POST /tenants/:id/api-key` to rotate |

### API changes this required

- **`GET /brain/selectors`** (new, `src/api/routes/brain.ts`) — read-only view of
  `selector_cache`. Returns tenant rows plus shared-pool rows for domains the tenant
  tests. Step text is recovered through `step_results.target_hash` (NOT
  `test_steps.content_hash` — the cache column stores the *target* hash), scoped to the
  tenant's own runs so shared rows never leak another tenant's step text. Entries the
  tenant's steps have used sort first.
- **`GET /runs`** — added `durationMs` and `totalTokens`.
- **`GET /runs/:id`** — added `duration_ms` (wall clock). Without it the UI could only sum
  step durations, which excludes browser boot and disagreed with the run list. Also now
  returns `old_selector`/`new_selector` on each step's healing events (backlog A1), which
  the query was dropping — that's the data behind the `was → now` heal diff.
- **Token totals `COALESCE(…, 0)`** in `GET /runs` and the case-detail `recentRuns` query.
  `SUM` over zero billing rows is NULL, which the UI showed as "—"/"no runs yet" when the
  truth was "this run was free" — the headline result for a cached run.
- **`DELETE /cases/:caseId`** — fixed a 23503 FK violation that made deleting any case
  with run history fail. Evidence (`healing_events` → `step_results`) is now removed
  before the `test_steps` it points at, and `test_cases.validation_run_id` is released
  before the runs go. Regression test in `src/api/routes/__tests__/test-cases.test.ts`.

### Motion + colour pass (Updated: 2026-07-30)

A second pass against the design's own capture restored what the first port had flattened:

- **Source tags carry the design's vocabulary and per-tier colour** — PATTERN / CACHE
  (neutral `--cache`), SIMILAR / GLOBAL (accent), AI (`--warn` amber, the only tier that
  costs money) — mapped from the real `resolution_source` via `SOURCE_OF`. The first port
  collapsed all six tiers to cached-vs-not, which threw away the story the screen exists
  to tell. The L-number survives on the tooltip.
- **Per-step motion**: a step animates `rise` once as it lands, or `heal-flash` if it
  healed. Both are keyframe animations on a node React only creates when the row flips
  from pending to landed (its key changes from `p<i>` to the step-result id), so the 2s
  live poll can't replay them.
- **The heal diff animates in place**: `.heal-old` strikes through, `.heal-arrow` and
  `.heal-new` stagger in — now on real `healing_events` data.
- **Previous-run comparison** on the summary strip: "1.17s faster than last", "was 84
  last run", derived from the case's real `recentRuns`.
- **Collapsed sidebar** moves the traffic lights and the reveal button into the content
  toolbar (`.win.sidebar-off .toolbar { padding-left: 96px }`), with ⌥⌘S — matching the
  design; previously collapsing simply lost the window chrome.
- **Run now navigates to the live run.** Staying on the list left the row pointing at the
  *previous* run until the next refetch, so opening it showed stale results for a test
  that was running right then.

Verified live: a test against a never-seen site resolved via the model (`AI 84 tok`,
amber) and on re-run resolved from memory (`PATTERN 0 tok`, neutral) with the strip
reading "1.17s faster than last / was 84 last run" — the product thesis, on real data.

### Design revision 2 — Aperture, the line, the payoff (Updated: 2026-08-02)

From `Kaizen (2)`, which adds three things to `Kaizen (1)`:

- **A third appearance, `aperture`, now the default.** A Portal/Satisfactory industrial
  skin: ceramic test-chamber panels on a dark void, dark seams, machined 3px radii,
  portal orange (`#f56a11`) for the machine acting and portal blue (`#0a84d8`) for
  memory. `aperture.css` is copied verbatim and imported from `layout.tsx` **after**
  `globals.css` — `[data-appearance=aperture]` and `:root` have identical specificity
  (0-1-0), so importing it first (via `@import` at the top of globals.css) silently let
  the base light tokens win and the skin never applied. ⇧⌘A cycles
  aperture → light → dark; the picker in Usage lists all three.
- **The production line** (`line-view.tsx`, a "Line" tab on the run screen). A run as a
  factory line: the session is the item on the belt, each step is a machine, machines
  that remember run free and the machine that has to think draws power. The design read
  a fixture; this reads the run's real step results, so each machine's source tag and
  cost is what actually happened. Steps that need no element resolution (navigate,
  assert) show `—` rather than a fabricated source.
- **The run-complete HUD** (`game.tsx`). Fires once when a run *this screen watched
  running* reaches a terminal state — opening a historical run must not replay it. Rows
  with no honest source are omitted: a first run has no "saved vs. last run" to show.
  "Selectors learned" counts what the run actually added to memory — AI resolutions plus
  successful heals.
- `CountUp` now animates every `Stat` value and the `Ring` label, and the ring sweeps up
  from zero. Both respect `prefers-reduced-motion`.
- **Not ported:** the design's automation-tier system (Tier 1–5 "Manual → Automated").

The revision also **darkened `--text-3`** (light `#9a9aa2` → `#6e6e77`, dark
`#75757e` → `#9a9aa5`). That was the open accessibility question in the backlog (X1):
`npm run audit:contrast` went from 159 findings below 3:1 to 10, with none unreadable.

### Deliberately not faked

The design carried mock data for things the backend has no source for. These were dropped
rather than invented: per-case cache % and step count, the CI-on-push toggle and its API
key, "Save draft", a token quota denominator (no endpoint exposes
`llm_budget_tokens_monthly`), cache-hit history ("was X% a month ago"), and per-step
before/after screenshot pairs (one shot per step is stored). The "was → now" selector
diff was on this list until the heal data was plumbed through — it is now real (backlog
A1). The Brain is read-only: pin/block is
the real per-step verdict, so it lives on the run's step inspector, not on three
invented buttons per row. The author screen's cost preview splits steps into
"needs no lookup" (navigation/waits — genuinely 0 tokens) and "finds an element", with no
invented token estimate.

### Mock policy and the MOCK badge (Updated: 2026-08-02)

The rule, in order of preference:

1. Real data → render it.
2. No source → omit the field, or show `—`. **Never** a plausible-looking value.
3. Placeholder anyway → wrap it in `<Mock reason="…">` (`components/design/mock.tsx`),
   which renders a visible `MOCK` chip. A fake number that looks real is worse in a demo
   than an ugly badge.

An audit of every screen found exactly one fixture still reaching the UI: the sidebar
fell back to `TENANT.user`, so a signed-in workspace could flash "Ada Lovelace" before
the session resolved. That was fixed rather than labelled — a fake person is not a
loading state; it now shows "Signing in…" and the row is disabled.

The design's unused sample content was then deleted outright (`TENANT`, `SUITES`,
`CASES`, `BY_SUITE`, `FOCUS_CASE`, `STEPS`, `RUN`, `HISTORY`, `RUNS_FEED`, `BRAIN`,
`COST_CURVE`, `API_KEYS`, plus the `FauxShot`/`SHOT_TEMPLATES` fake-browser graphics).
Unreferenced fixtures are precisely how fake values creep back in. `data.ts` now holds
only vocabulary: `SOURCES`, `NAV`, `fmt`. Recover anything from the design folder if
needed.

`npm run audit:mock` walks all 14 surfaces — including first paint after sign-in, where
identity fallbacks show — and fails if any fixture string appears in the DOM. It reports
`<Mock>`-labelled elements separately, since a labelled placeholder is honest. Source
review alone cannot catch this class of bug: a fallback only renders under conditions
(null user, empty list) that reading past an `??` misses.

### Verified end to end

Against the real stack (API :3000, worker, Postgres, Redis) as a real seeded tenant:
signed in → created a test through the UI → watched it run live (steps landing, spinner,
2s polling) → passed on `the-internet.herokuapp.com` with real L0/L1 tier badges, real
timings and a real evidence screenshot → activity + history tabs → Runs feed → The Brain
(23 learned selectors, real confidence and outcome windows) → Usage (real tokens, runs,
members) → both appearances → deleted the test through the row menu and confirm sheet,
count returned to 7. No console errors, no failed requests, 566 unit tests green.
