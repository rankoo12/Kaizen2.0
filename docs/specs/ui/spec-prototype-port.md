# Spec: Prototype Port — Kaizen UI Redesign

Created: 2026-04-26
Updated: 2026-04-26 (rev 2 — WIP convention, .old archival, drop workspace + cmd-K)

## 1. Context

A self-contained React prototype lives under `docs/design/UI/`. It defines the next visual direction for Kaizen as a complete redesign — not a refinement of the current production UI. The prototype runs through React UMD + Babel-standalone with inline `style={{...}}` props, so it cannot be ported file-for-file: production is Next.js 15 + Tailwind v4 with strict atomic design and a hard "no hardcoded CSS outside Tailwind" rule (`docs/CLAUDE.md`).

This spec defines how to translate the prototype into production code without breaking the architecture or losing the design intent.

## 2. Goals

- Adopt the prototype's design tokens, motion vocabulary, and screen layouts as the production UI.
- Preserve all current data flows: `useSuites`, `useCases`, `useRunPoller`, `/api/proxy/*`, `AuthContext`.
- Keep the production font stack (Inter / Space Grotesk / Manrope). The prototype's Instrument Serif / Geist / JetBrains Mono are **not** adopted.
- Stay inside Tailwind utility classes; expose new tokens through `@theme` so utilities like `bg-surface` and `text-text-hi` resolve correctly.
- Three themes (`nebula`, `deep-space`, `solar-flare`) keep working through the existing `data-theme` attribute flip.

## 3. Non-goals

- No backend changes. No new routes, no new hooks, no new API contracts.
- No new font imports.
- No port of the prototype's `tweaks-panel` (developer-only design playground).
- **Dropped entirely** (not deferred, not stubbed): Acme workspace switcher, cmd-K palette. Both removed from the side rail / top bar.

## 4. Design tokens

The prototype's `styles.css` introduces a wider token system than current production. New tokens land in `packages/web/src/app/globals.css` under each `[data-theme]` root and the `@theme` block, so Tailwind utilities resolve them.

**Added across all three themes:**
- Surfaces: `--surface`, `--surface-elevated`, `--surface-sunken`, `--app-bg-deep`
- Borders: `--border-strong`, `--border-accent` (existing `--border-subtle` retained)
- Brand glows: `--brand-primary-glow`, `--brand-accent-glow`
- Text scale: `--text-hi`, `--text` (default), `--text-mid`, `--text-low`, `--text-faint`
- Status glows: `--danger-glow`, `--success-glow`
- Focus: `--focus-ring`
- Neural canvas: `--neural-color-a/b/c`

**Density variant** (off by default): `[data-density="comfortable"]` raises `--density-pad/row/gap`. Production wires the attribute but ships in the default tight density.

**Legacy aliases preserved** (`--color-brand-orange`, etc.) so existing organisms keep rendering during the staged migration. They get removed once all call sites move to the new names.

## 5. Motion

Prototype keyframes ported into `globals.css` and exposed via `.animate-*` utility classes:

- Existing keep working: `toastDrop`, `modalPop`, `pulseRed`, `glowGreen`, `sweep`
- New: `scan`, `shimmer` (used by `.skeleton`), `orbit` (running-test indicator), `healingPulse` (self-heal pulse), `typeBlink` (`.caret`), `runStart`, `traceTick`, `orbitDot`

`prefers-reduced-motion: reduce` disables every infinite animation.

## 6. Layout architecture

The prototype assumes a persistent app shell (left side rail + top bar) wrapping every authenticated screen. Production currently has no shell — each page draws its own nav. The port introduces a Next.js route group:

```
packages/web/src/app/
  (app)/                   ← new route group with shared chrome
    layout.tsx             ← side rail + top bar + outlet
    tests/
      page.tsx             ← was /tests/page.tsx
      new/page.tsx
      [id]/page.tsx
```

Login / signup / welcome stay outside `(app)` (no shell, full-bleed).

## 7. Component port map

| Prototype | Production | Notes |
|---|---|---|
| `shell.jsx::SideRail` | `organisms/app-shell/side-rail.tsx` | Logo, workspace pill (static "Acme"), nav, recent runs (uses `useSuites`/`useCases` until a dedicated hook exists), engine widget (static), profile pill (from `AuthContext`). |
| `shell.jsx::TopBar` | `organisms/app-shell/top-bar.tsx` | Breadcrumbs prop-driven, kbar hint as decorative button (deferred), bell + sparkle as `IconButton`. |
| `shell.jsx::Logo` | replace `atoms/logo.tsx` | New rotated-square mark with brand-accent dot. |
| `shell.jsx::StatusDot` | `atoms/status-dot.tsx` | New atom. |
| `shell.jsx::IconButton` | `atoms/icon-button.tsx` | New atom. |
| `shell.jsx::MusicPlayer` | refresh `molecules/music-player.tsx` | Keep current state model; restyle to floating pill. |
| `shell.jsx::Toast` | `atoms/toast.tsx` | Replace inline toast in `tests-panel`. |
| `tests-dashboard.jsx::TestsDashboard` | replace `organisms/tests-panel.tsx` | Becomes `organisms/tests-dashboard.tsx`. |
| `tests-dashboard.jsx::SummaryStrip + PassRing` | `organisms/tests-summary-strip.tsx` | Wires to `useSuites` aggregates. Trend numbers are static for v1. |
| `tests-dashboard.jsx::GridView + TestCell + TestHoverCard` | inside `tests-dashboard.tsx` | `TestCell` reuses existing run-status data from `useCases`. Hover card replaces current `TestTooltip`. |
| `tests-dashboard.jsx::ListView` | inside `tests-dashboard.tsx` | New view mode; toggle stored in component state. |
| `new-test-screen.jsx::*` | replace `organisms/new-test-panel.tsx` | Steps composer, compiler card (static for v1), config card (toggles store local state — wiring to backend is out of scope), cost card (static). |
| `test-detail-screen.jsx::*` | replace `organisms/test-overview-panel.tsx` | Run summary strip, history rail, gantt strip, timeline/gantt/logs viz, step inspector. Wires to `useCaseDetail`/`useRunDetail`/`useRunPoller`. Fields not in the API (e.g. per-step token cost) read from existing types or are hidden. |
| `auth-screens.jsx` | refresh `organisms/auth-card.tsx`, `login-form.tsx`, `signup-form.tsx`, `welcome-hero.tsx` | New token surfaces, starfield, brand glow on submit. Form logic unchanged. |
| `neural-background.jsx` | refresh `organisms/neural-background.tsx` | Use `--neural-color-a/b/c`; visual update only. |
| `tweaks-panel.jsx` | **not ported** | Developer playground; out of scope. |

## 8. Data wiring

The prototype uses static fixtures (`data.jsx`). Production data sources stay as-is:

- Suite list → `useSuites()`
- Case list per suite → `useCases(suiteId)`
- Case detail + steps → `useCaseDetail(caseId)`
- Run polling → `useRunPoller({ runId, onComplete })`
- Run mutation → `POST /api/proxy/cases/:id/run`

### WIP convention

Where the prototype shows a field the backend doesn't yet expose, the slot is **never hidden and never faked**. Instead, render the literal string `WIP` in place of the value, styled with the same dim treatment as `--text-faint`. This makes unfinished surfaces obvious during the staged port and acts as a punch list.

Known WIP slots in v1:

- Per-step token cost (`step_results` doesn't emit it).
- Per-test "last 12 runs" sparkline (no aggregated history endpoint yet).
- "Branch" tag on test detail header (no branch field on cases yet).
- Compiler card stats on `/tests/new` (compiler exposes no realtime preview API).
- Cost card on `/tests/new`.
- Self-heal trace on test detail (selector before/after not exposed yet).
- Engine widget in side rail (workers / queue / region — no `useEngineStatus` hook).
- Recent runs strip in side rail (no `useRecentRuns` hook).
- Run history rail on test detail (no per-case run-list endpoint).

Each slot uses the shared `<Wip />` atom (see §11) so they're trivial to grep and replace as backends land.

## 9. Tailwind constraints

Per `docs/CLAUDE.md` the port honors:

- "No hardcoded CSS outside Tailwind utility classes." Prototype's `style={{ background: 'var(--surface)' }}` becomes Tailwind utilities like `bg-surface`. New tokens are added to `@theme` so they're addressable.
- "No `any` types without justification."
- "Atomic Design strictly." Prototype components are split across atoms/molecules/organisms before they land.
- `cn()` from `lib/cn.ts` for every `className`.

A few non-Tailwind expressions remain unavoidable: keyframes, `::-webkit-scrollbar`, `::selection`, `:focus-visible`. These live in `globals.css` (already established convention).

## 10. Migration sequencing

Implementation order (each step is independently shippable). **Old code archival rule:** when an organism / page is replaced, the old file is **moved** (not deleted, not duplicated) into a sibling `.old/` directory. Concretely:

- `packages/web/src/components/organisms/tests-panel.tsx` → `packages/web/src/components/organisms/.old/tests-panel.tsx`
- Same pattern for `new-test-panel.tsx`, `test-overview-panel.tsx`, etc.
- Old atom shapes (e.g. previous `logo.tsx`) → `packages/web/src/components/atoms/.old/`

`.old/` is excluded from imports — nothing in production code references it. It exists as a recovery checkpoint and is removed wholesale at step 7.

Steps:

1. **Tokens + motion** in `globals.css`. Existing pages still render via legacy aliases.
2. **Shared chrome + atoms**: `(app)/layout.tsx`, `SideRail`, `TopBar`, `Logo`, `StatusDot`, `IconButton`, `Toast`, `Wip`. No screen wired yet.
3. **Tests dashboard**: move `/tests/page.tsx` under `(app)/tests/`, replace `TestsPanel`, archive old to `.old/`.
4. **New Test screen**: same migration for `/tests/new`.
5. **Test Detail screen**: same migration for `/tests/[id]`.
6. **Auth screens refresh**: welcome, login, signup re-skinned. Logic untouched.
7. **Cleanup**: delete every `.old/` directory; drop legacy color aliases (`--color-brand-orange` etc.) once nothing references them.

Each step ends with `npm run typecheck && npm run lint` clean.

## 11. The `<Wip />` atom

`packages/web/src/components/atoms/wip.tsx` — single source of truth for "this slot is not wired yet."

```tsx
import { cn } from '@/lib/cn';

type WipProps = { className?: string; label?: string };

export function Wip({ className, label = 'WIP' }: WipProps) {
  return (
    <span
      className={cn(
        'font-mono text-[10px] tracking-[0.18em] uppercase text-text-faint',
        className,
      )}
      title="Work in progress — backend or data source not wired yet"
      aria-label="work in progress"
    >
      {label}
    </span>
  );
}
```

Rendered inline wherever a real value would go. Greppable: `<Wip />` lists every unfinished slot in one search.

## 12. Test plan

Component test coverage at the same level as the organisms being replaced:

- `tests-dashboard.test.tsx` — filter/search/select, suite group rendering, view toggle.
- `new-test-panel.test.tsx` — step add/delete/edit, compile-and-run handler, cost-card render.
- `test-overview-panel.test.tsx` — run history selection, viz mode switch, step inspector renders for healed/failed/passed.
- `side-rail.test.tsx` — active nav highlight, profile pill from `AuthContext`.

Visual smoke: run `npm run dev` in `packages/web/` and click through the three authenticated screens + auth flow before declaring done.

## 13. Resolved decisions (rev 2)

- Workspace switcher: **dropped**. No workspace concept on frontend.
- cmd-K palette: **dropped**. No command bar on roadmap.
- Branch selector + sync-from-main: render UI, handler renders `<Wip />` toast on click.
- Per-step token cost: render `<Wip />` in place of the value (not hidden).
