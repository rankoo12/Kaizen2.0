# UI & UX Enhancements

This spec defines the **visual and interaction language** for Kaizen 2.0. It does not prescribe page layouts — those stay free per-page — but it locks down the primitives, motion, and theming that every page inherits.

The goal: a **modern, premium, restrained** interface. The overall mood is *"space / space station"* — cold depth, signal-light accents, controlled glow — but this is a vibe, not a literal aesthetic. The welcome page's 3D neural scene is the flagship expression; other pages borrow the mood through color, motion, and surface treatment without needing WebGL.

---

## §0 — Design Language

### Mood

Kaizen should feel like instrumentation, not a chatbot. Surfaces are dark and deep. Accents are used sparingly, like status LEDs — not decoratively. Motion is fast, purposeful, and tactile. Negative space is a feature, not a gap to fill.

### Never ship

The following are explicitly out-of-bounds regardless of context. Treat as hard prohibitions:

- ✨ sparkle icons, wand icons, "magic" imagery, or any "AI-powered" badges
- Purple/violet gradients (we are pink/orange/warm — hold the line)
- Chat-bubble UIs for test authoring or any primary workflow
- Robot, brain, or humanoid mascot iconography
- Generic Material or Fluent-style card shadows (`shadow-md`, `shadow-lg`) — we use glow, not drop-shadow
- "AI" as a visible feature label anywhere in the product surface
- Emoji-as-icon in production UI (temporary dev scaffolding is fine)

### Feel targets

Every screen should, within 3 seconds of loading, communicate:

- **Depth** — there is a background, a surface, and an accent layer. No flat walls of color.
- **Signal** — the accent color appears once or twice per viewport, not everywhere.
- **Calm** — nothing animates unless the user caused it or the data changed.

---

## §1 — Theming System

### Architecture

All color decisions route through CSS custom properties declared on `:root` and overridden on `[data-theme="<name>"]`. Tailwind's `@theme` block in [globals.css](../packages/web/src/app/globals.css) consumes these variables so utility classes (`bg-app-bg`, `text-brand-orange`, etc.) automatically respect the active theme.

```css
:root,
[data-theme="nebula"] {
  --color-app-bg:        #18121d;
  --color-welcome-bg:    #130d17;
  --color-card-bg:       #231b29;
  --color-input-bg:      #18121d;
  --color-border-subtle: rgba(255, 255, 255, 0.0625);
  --color-brand-primary: #d5601c; /* orange */
  --color-brand-accent:  #db87af; /* pink */
  --color-brand-primary-soft: #e59365;
  --color-brand-accent-soft:  #ebd1de;
}

[data-theme="deep-space"] {
  --color-app-bg:        #0b1220;
  --color-welcome-bg:    #070c17;
  --color-card-bg:       #111a2e;
  --color-input-bg:      #0b1220;
  --color-border-subtle: rgba(120, 200, 255, 0.08);
  --color-brand-primary: #38bdf8; /* cyan */
  --color-brand-accent:  #818cf8; /* cool indigo */
  --color-brand-primary-soft: #7dd3fc;
  --color-brand-accent-soft:  #c7d2fe;
}

[data-theme="solar-flare"] {
  --color-app-bg:        #1a1208;
  --color-welcome-bg:    #130c04;
  --color-card-bg":      #2a1c0e;
  --color-input-bg:      #1a1208;
  --color-border-subtle: rgba(255, 215, 160, 0.08);
  --color-brand-primary: #f59e0b; /* gold */
  --color-brand-accent:  #ef4444; /* crimson */
  --color-brand-primary-soft: #fbbf24;
  --color-brand-accent-soft:  #fca5a5;
}
```

> Note: the existing palette tokens (`--color-brand-orange`, `--color-brand-pink`, etc.) remain as **aliases** of `--color-brand-primary` / `--color-brand-accent` during migration so nothing breaks. Remove the aliases once all call sites are migrated.

### Themes shipped in v1

| Theme name    | Default? | Direction                                                  |
|---------------|----------|------------------------------------------------------------|
| `nebula`      | ✅       | Current pink + orange. Warm, organic, the flagship mood.   |
| `deep-space`  |          | Cyan + indigo on navy. Colder, more instrument-panel.      |
| `solar-flare` |          | Gold + crimson on warm black. Dramatic, high-contrast.     |

### Switcher

- A `<ThemeSwitcher />` molecule lives in the global header/user menu (not a floating widget).
- Selection persists to `localStorage` under key `kaizen:theme`.
- On app boot, a tiny inline script in `packages/web/src/app/layout.tsx` reads the stored theme and sets `data-theme` on `<html>` *before* React hydrates — this prevents flash-of-wrong-theme on navigation.
- The 3D `<NeuralBackground />` reads the current palette via `getComputedStyle` at mount so its emissive colors match the active theme. A theme change triggers a scene re-render.

### Theme-independent tokens

Some things **must not change** across themes: font families, radii, spacing scale, motion durations, border-subtle opacity logic (the *rule* stays; the *color* varies). Only the color tokens listed above are themeable.

---

## §2 — Component Primitives

Every page must use these primitives. New components that duplicate their behavior are not allowed — extend or compose instead. Location: [packages/web/src/components/atoms](../packages/web/src/components/atoms) and [molecules](../packages/web/src/components/molecules).

### 2.1 Button

One atom, three intents, two sizes.

| Intent      | Use case                                          | Surface                                            |
|-------------|---------------------------------------------------|----------------------------------------------------|
| `primary`   | The one thing the user is here to do             | Gradient fill using `brand-accent-soft → accent`  |
| `secondary` | Navigate, cancel, view more                      | Transparent, bordered with `brand-primary/50`     |
| `ghost`     | Low-priority inline actions (dismiss, toggle)    | Transparent, hover-only background                |

Sizes: `md` (default, 44px tall) and `sm` (32px tall, used in tables and toolbars).

All buttons share:

```tsx
"rounded-xl font-medium transition-all duration-300 ease-out
 active:scale-95 disabled:opacity-40 disabled:pointer-events-none
 focus-visible:outline-none focus-visible:ring-2
 focus-visible:ring-brand-accent focus-visible:ring-offset-2
 focus-visible:ring-offset-app-bg"
```

Primary-specific hover: `hover:-translate-y-0.5 hover:shadow-[0_0_20px_var(--color-brand-accent)]` (opacity 0.4 on the glow color via `color-mix` or a pre-computed soft token).

### 2.2 Input / Textarea

- Base: `bg-input-bg border border-border-subtle rounded-lg px-4 py-3`
- Focus: `focus:border-brand-accent focus:ring-1 focus:ring-brand-accent/40` — never use the browser default outline
- Error state: `border-brand-red` plus a thin helper-text row beneath (never tooltip-only)
- Disabled: `opacity-40` — do not use a gray fill, themes handle it via opacity

### 2.3 FormField

A molecule wrapping `<label>` + input + helper/error text. Every form field in the product uses this. Direct `<input>` with a sibling `<label>` is not allowed in page code.

### 2.4 Card

- `bg-card-bg/80 backdrop-blur-md border border-border-subtle rounded-xl`
- Padding defaults to `p-6` for content cards, `p-4` for compact/list cards
- Hover (if interactive): `hover:border-brand-accent/40 transition-colors duration-300`
- No drop-shadow. Ever. Depth comes from backdrop-blur against the dark background, not from shadow.

### 2.5 Modal

- Uses the existing `animate-modal-pop` keyframe in [globals.css:48-52](../packages/web/src/app/globals.css#L48-L52)
- Backdrop: `bg-black/60 backdrop-blur-sm`
- Surface: same treatment as Card, but `rounded-2xl` and a subtle inner glow via `shadow-[inset_0_0_40px_var(--color-brand-accent)]` at ~4% opacity

### 2.6 Toast

Already defined via `animate-toast-drop` in [globals.css:40-45](../packages/web/src/app/globals.css#L40-L45). Keep the behavior; ensure the surface uses the glassmorphic card treatment.

---

## §3 — Motion & Feel

### 3.1 Tactile feedback

- `active:scale-95` on every clickable primitive (buttons, icon buttons, interactive cards)
- `transition-all duration-300 ease-out` is the default. Faster (`duration-150`) for micro-interactions like icon toggles. Slower than 300ms is reserved for theatrical moments (modal entry).

### 3.2 Glow on hover

Primary CTAs gain an outward glow on hover keyed to the active theme's accent:

```
hover:shadow-[0_0_20px_color-mix(in_oklab,var(--color-brand-accent)_40%,transparent)]
```

Glow appears *only* on hover, never as ambient decoration on static surfaces. The welcome page's 3D cubes are the one exception — they *are* decoration.

### 3.3 Glassmorphism

- Surfaces that sit above the page background use `bg-<surface>/80 backdrop-blur-md`
- Borders use `border-border-subtle` — never default Tailwind `border-white/10` literals
- Do not nest glass inside glass more than one level. Flatten the hierarchy instead.

### 3.4 Reduced motion

All custom animations declared in [globals.css](../packages/web/src/app/globals.css) must be wrapped by a `@media (prefers-reduced-motion: reduce)` override that disables transform/opacity loops. Scale/glow hover states are allowed; infinite keyframe loops (`animate-pulse-red`, `animate-glow-green`) are not.

### 3.5 Music player

A persistent, **opt-in, off by default** ambient player. This is for delight, not functionality — it must never be in the user's way.

**Architecture**

- Molecule: `packages/web/src/components/molecules/music-player.tsx`
- Mounted in [packages/web/src/app/layout.tsx](../packages/web/src/app/layout.tsx) so route transitions don't tear down the `<audio>` element
- Position: fixed bottom-right, above toasts, below modals

**Behavior**

- Default state on first load: **closed** (not visible, no audio element)
- User reveals it via a tiny icon button in the header/user menu
- Once revealed: compact glassmorphic pill with play/pause, a spinning vinyl icon, and an `✕` to close
- `✕` fully dismisses the component and persists `kaizen:music-player:dismissed = true` in localStorage — it stays closed across sessions until the user re-enables from settings
- Play state, volume, and current track persist to localStorage so navigation never restarts playback
- No autoplay ever. First play requires a user click (also a browser constraint)

**Aesthetic**

- `bg-card-bg/80 backdrop-blur-md border border-border-subtle rounded-full px-4 py-2`
- Spinning vinyl animates only when playing
- Never pulses, flashes, or demands attention

---

## §4 — Implementation Checklist

This section tracks the minimum work to land the system. Ordered by dependency.

1. **Extend `@theme` in [globals.css](../packages/web/src/app/globals.css)** to route all color tokens through CSS variables defined under `:root` and `[data-theme="..."]` selectors. Keep existing token names as aliases during migration.
2. **Add theme definitions** for `nebula` (default), `deep-space`, and `solar-flare`.
3. **Add pre-hydration theme script** to [layout.tsx](../packages/web/src/app/layout.tsx) that sets `data-theme` from localStorage before React renders.
4. **Build `<ThemeSwitcher />`** as a molecule. Wire into global header.
5. **Refactor `<NeuralBackground />`** to read theme colors at mount via `getComputedStyle`. Trigger rebuild on theme change.
6. **Audit existing buttons** across the app. Consolidate into a single `<Button />` atom with the three intents from §2.1. Replace all ad-hoc `<button className="...">` tags in page code.
7. **Audit existing inputs/forms.** Consolidate into `<Input />` + `<FormField />`. Remove direct `<label>` + `<input>` pairs in page code.
8. **Audit cards and modals** for glassmorphism compliance. Remove `shadow-md`/`shadow-lg` usages; replace with the glow-on-hover pattern where applicable.
9. **Build `<MusicPlayer />`** per §3.5. Default-closed, localStorage-persisted.
10. **Add `prefers-reduced-motion` guards** to infinite animations in [globals.css](../packages/web/src/app/globals.css).
11. **Delete unused color aliases** from `@theme` once all call sites are migrated off the legacy `--color-brand-orange` / `--color-brand-pink` names.

---

## §5 — Out of Scope

The following are explicitly not addressed here and will be tracked separately:

- Page-level layouts (dashboard, test editor, run viewer) — each page owns its own layout; this spec only governs the primitives inside
- Accessibility audit beyond focus rings and reduced-motion (contrast ratios, keyboard nav, screen reader semantics — own spec)
- Marketing site styling (the welcome page is the product entry point, not a marketing site)
- Mobile/responsive breakpoints beyond the existing `md:` / `lg:` usage — the product is desktop-first by design
