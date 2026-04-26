# Spec: Design Fixes Batch (post prototype-port)

Created: 2026-04-27
Updated: 2026-04-27

## 1. Context

The prototype port (PR `feat/ui/prototype-port`) shipped the new design across
`/tests`, `/tests/new`, and `/tests/[id]`. User-testing surfaced five UI issues
that don't share a single root cause but all affect the polish of the new
design. Bundling them into one spec keeps the punch list visible without
generating five one-paragraph spec files.

This spec covers UI-only changes. Backend behaviour is untouched.

## 2. Issues

### 2.1 Hover card clipping on `/tests`

The test hover card on the dashboard renders fixed-position relative to the
cursor. When the hovered cell is near the right edge of the viewport, the card
overflows past the right edge — the `FAILED` chip is cut off and the card body
is clipped.

**Cause.** [tests-dashboard.tsx](packages/web/src/components/organisms/tests-dashboard.tsx)
positions the card with `transform: translate(-50%, calc(-100% - 12px))`
without a viewport-edge clamp.

**Fix.** Clamp `left` to `[8, viewportWidth - cardWidth - 8]`. Also flip the card
**below** the cell when `top` would put it above the viewport top edge.

### 2.2 Auth screens use the old design

`/login` and `/signup` still render the old auth-card design with no shared
backdrop. The user expects the new design language carried over: `ShellBackground`
(animated nodes + connecting lines, theme-aware) as the backdrop, surfaces and
typography matching the rest of the app.

**Decisions.**
- The screens stay **outside** the `(app)` route group — no side rail, no top
  bar, no breadcrumbs. The user is unauthenticated; there's no nav target.
- `ShellBackground` is reusable; a thin `<AuthShell>` wrapper renders it as a
  fixed backdrop and centers its child auth card on top.
- `/` welcome screen is **explicitly out of scope** — it stays as is per user
  instruction. Don't touch `welcome-hero.tsx`.

**Affected files.**
- New: `packages/web/src/components/organisms/auth-shell.tsx` (centered card on
  top of `ShellBackground`).
- Update: `packages/web/src/app/login/page.tsx`, `packages/web/src/app/signup/page.tsx`,
  `packages/web/src/components/organisms/auth-card.tsx`,
  `packages/web/src/components/organisms/login-form.tsx`,
  `packages/web/src/components/organisms/signup-form.tsx`.

Re-skin only — form logic / `useAuth` calls untouched.

### 2.3 Test detail UI is too dense / too large

Per-step rows, the run summary strip, and the heading typography on
`/tests/[id]` feel oversized compared to the dashboard. Whole-page scaling pass
needed: smaller heading, tighter padding, smaller summary cells, smaller step
node, smaller chip text.

**Specific deltas** (rough — final values picked at implementation time):
- Page heading: `text-[28px]` → `text-[22px]`
- Run summary cell value: `text-[18px]` → `text-[15px]`
- Run summary strip vertical padding: `py-3.5` → `py-2.5`
- Step row vertical padding: `py-2.5` → `py-2`
- Step node: 14×14 → 11×11
- Inspector heading: `text-[14px]` → `text-[13px]`
- Body text: stays `text-[13px]` for readability
- Side rail width: stays — out of scope

### 2.4 Step inspector missing step text + slow screenshot load

Two related sub-issues:

**a. Missing step text.** When a step is selected, the inspector renders the
status / token / duration chips but **not the step's natural-language text**.
The text exists at `test.steps.find(s => s.id === stepResult.stepId)?.rawText`
and is already passed into `StepInspector` as the `stepText` prop — it's just
not rendered. Bug fix: render `stepText` as the inspector heading above the
chips.

**b. Slow screenshot load.** Each step's screenshot is fetched only when its
inspector renders. Switching steps triggers a fresh fetch + decode, ~300–800ms
of perceived lag.

**Fix.** Preload all screenshots when the run loads. On run-detail mount,
iterate `stepResults` and `new Image()` each `screenshotKey`. The browser's
HTTP cache and image cache absorb the cost; subsequent inspector renders read
from cache.

Implementation: `useEffect` in `TestDetailScreen` keyed on `run?.id` that walks
`run.stepResults` and triggers preload for every `screenshotKey`.

### 2.5 Bidirectional scroll sync between timeline and step inspector

Current state: the inspector renders **one** step's full detail. Selecting a
step in the timeline replaces the inspector content. There's no scroll
relationship.

Target state: the inspector becomes a **scrollable list** of every step's
full block (status + chips + screenshot + heal trace + failure trace +
resolution + LLM candidates + verdict buttons). Scrolling the inspector
highlights the timeline row that's currently in view; clicking a timeline row
scrolls the inspector to that step's block.

**Implementation sketch.**
- `StepInspector` becomes `StepInspectorList` rendering `stepResults.map(...)`,
  each block keyed by `stepResult.id` and given `id={`step-${id}`}` for anchor
  scroll.
- New `activeStepId` (already exists at the parent) drives:
  - Timeline highlight (already wired).
  - Inspector auto-scroll: `useEffect` on `activeStepId` calls
    `scrollIntoView({ behavior: 'smooth', block: 'start' })` on the matching
    block — guarded by a "did user just click vs. did user just scroll" flag
    to prevent ping-pong.
- Inspector scroll → timeline highlight: `IntersectionObserver` on each step
  block; when a block becomes the most-visible one, set `activeStepId` to its
  step. Throttle / `requestAnimationFrame` to avoid noise.

The "did user just click" flag is a `useRef<boolean>` that's set to `true` for
~500ms after a timeline click, suppressing the IntersectionObserver-driven
update during that window. Without it the smooth-scroll animation triggers
intersection events that fight the click.

**Affected files.**
- `packages/web/src/components/organisms/test-detail-screen.tsx` —
  `StepInspector` becomes `StepInspectorList`. The single-step rendering path
  goes away. Run-history rail layout might need reflow to give the inspector
  more vertical room.

### 2.6 Test detail header — duplicate row

Lower priority but visible: the breadcrumbs already show `Tests > test_name`
in the top bar, then the page header below it shows `← #026f52` again, then
the test name as a heading. The `#026f52` row is redundant.

**Fix.** Drop the `← #id updated <date>` row entirely; keep just the back
arrow inline with the heading. The `updated <date>` info already lives in
the run summary strip's "When" cell.

## 3. Non-goals

- No new screens or routes.
- No backend changes.
- Welcome screen visual stays as-is (user explicitly opted out).
- WIP slots stay WIP. This spec doesn't widen the surface of "real" data;
  it just polishes what's already there.

## 4. Test plan

- Hover the right-most cell of every suite — card stays inside the viewport.
- Hover a top-row cell — card flips below the cell.
- `/login` and `/signup` show the animated background, the auth card surface
  uses the new tokens, fonts match the dashboard.
- Test detail page reads as compact compared to the prototype-port version;
  no horizontal scroll on a 1280-wide viewport.
- Selecting any step in the timeline (a) shows that step's text at the top of
  the inspector block, (b) scrolls the inspector smoothly to that step.
- Scrolling the inspector marks the visible step as active in the timeline.
- Switching steps in rapid succession — screenshot lightbox-target stays
  current with the active step; no flash of broken image.
- Reduced motion: scroll behaviour is `auto` instead of `smooth`.

## 5. Sequencing

Recommended order, cheapest first:

1. 2.1 hover card clamp
2. 2.2 auth screens refresh
3. 2.4 step text + screenshot preload
4. 2.6 dedupe header row
5. 2.3 test detail scale-down
6. 2.5 inspector bidirectional sync (largest piece)

`npm run typecheck && npm run lint` clean after each step.
