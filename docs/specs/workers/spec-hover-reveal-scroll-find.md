# Spec: Hover-to-Reveal and Scroll-to-Find

Created: 2026-10-11
Updated: 2026-10-11 — second reveal hook (action-failed path) + cache guard

Two engine capability gaps surfaced by the changing-sites bench (findings #7
and #8 in docs/specs/bench/spec-changing-sites.md §12), both of the same
family: **the target exists but is not currently visible/rendered, and the
engine gives up instead of doing what a human tester does next.**

## §1 Hover-to-reveal (finding #7)

A control inside a CSS `:hover`-revealed container (a "⋯" menu) is hidden at
resolution time: the pruner never surfaces it, resolution returns nothing or a
suspect wrong pick, and the step dies. A human hovers the menu trigger first.

**Behavior** (`src/workers/reveal.ts`, wired into the worker's resolution
recovery): when a retryable interaction ends its recovery with no selectors or
a still-suspect pick, scan the live DOM for HIDDEN elements whose
aria-label/text carries the step's named target (quoted name, or all salient
words). For each hit (max 3): stamp it and its nearest VISIBLE ancestor with
`data-kz-reveal*` markers, hover the ancestor via a real mouse hover, wait
briefly, and check the target became visible. First success wins: the step
proceeds against the revealed element with `resolutionSource: 'reveal'`.

Safety: strict name containment (never reveals a lookalike), post-hover
visibility verification, bounded (3 candidates × 1 hover each), runs ONLY on
the already-failed recovery path, and the mouse is left resting on the anchor
so the hover state survives into the action (Playwright moves the pointer onto
the revealed descendant, which keeps the ancestor's `:hover` chain active).

**Two hooks, same driver.** The resolution-time hook above fires when
resolution ends EMPTY or suspect — the first run's path, before anything is
cached. But once the cache has learned the right selector for the hidden
element (`role=button[name="Block"]` for Buzzly's "⋯"-menu item), resolution
SUCCEEDS and the gate never fires; the action then dies on a hidden element
and the healing chain re-resolves onto a name-mismatched neighbour ("More
options" for "Block" — observed live, v2 r2). So a second hook runs after a
retryable interaction FAILS: try `revealHiddenTarget`, re-execute the step
against the revealed selector, and adopt the result only when that retry
passes; otherwise the classify→heal path proceeds exactly as before.

**Cache guard.** A reveal pass executes against a `data-kz-reveal` stamp that
dies with the page, so `recordSuccess` skips `resolutionSource: 'reveal'`
(same rule as `click_random`'s transient marker) — persisting the stamp would
poison the next run's resolution with a dead selector. The near-miss that
mandated this: r1's stamp WAS briefly cached and only survived because the
seed's two same-named "Block" steps share a targetHash and the second step's
honest selector overwrote it.

## §2 Scroll-to-find (finding #8)

Virtualized/windowed lists render only the visible rows; content deeper in the
list is NOT in the DOM, so `assert_text`'s whole-page poll can never see it. A
human scrolls.

**Behavior** (`playwright.execution-engine.ts`, assert_text only): after the
existing ~8s poll misses, enumerate scrollable containers (scrollHeight −
clientHeight > 100, overflow-y auto/scroll, plus the document scroller; max
5), snapshot their positions, then advance ALL of them one viewport-step
(~90% of clientHeight) at a time, re-running the same page scan between steps.
Bounded: max 60 steps, stop early when nothing advanced (every container at
bottom). On a find, scroll positions stay (the content is now rendered); on a
miss, positions are restored and the assertion fails exactly as before.

Scope notes: main frame only; `assert_not_text` is deliberately untouched (its
"absent" semantics already scan the full body text, and auto-scrolling an
absence check changes its meaning); interactions get scroll-to-find only
indirectly (a later extension) — the bench case is the content assertion.

## §3 Cost envelope

Both features run exclusively on paths that were already about to fail, so the
hot path pays nothing. Worst case added latency: reveal ≈ 1s (3 hovers);
scroll sweep ≈ 60 × (step + 150ms settle) ≈ 12s, only when scrollables exist
and the text was absent after the normal poll. The action-failed reveal hook
adds one DOM scan per failed retryable interaction (a page.evaluate, no model
call) before the healing chain runs.

## §4 Verification

Unit: reveal.ts driver against a fake page (scan→hover→verify orchestration);
engine sweep against a fake page whose scan misses until a scroll advanced.
Live: Buzzly seeds "Block a user through the hover menu and dialog" (#7) and
"Scroll to a deep post in the virtualized feed" (#8) flip from FAIL to PASS in
the changing-sites judge, with no regression elsewhere on the fleet.
