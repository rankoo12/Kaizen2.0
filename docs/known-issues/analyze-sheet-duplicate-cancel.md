# Analyze sheet: two "Cancel" buttons, one of them does not close the sheet

**Created:** 2026-08-20
**Found by:** the Test Writer's own generated test ("Open the Analyze sheet and cancel it"),
failed identically in two independent bench runs (kaizen19, kaizen21); confirmed by hand with
Playwright the same day.

## What happens

The Analyze-an-app sheet (`packages/web`, Analyses screen) renders **two buttons with the
accessible name "Cancel"**:

- `button.btn.ghost` — clicking it does **not** close the sheet;
- `button.btn.lg` — the real close.

A third background "Cancel" (a test row named with the word) is also reachable by name from the
page, behind the scrim.

## Why it matters

- Assistive-technology users hear two identical "Cancel" announcements with different effects.
- Any tester — human or automated — clicking "Cancel" has a coin-flip chance of a dead click.
  Two proving runs failed on `verify the "App URL" field is not visible` exactly this way.

## Fix direction

Name each button by what it does (e.g. the ghost one is presumably "Clear description" or
belongs to the Advanced sub-form). One accessible name per action per surface.

## Status

Open. Recon now reports this class automatically as a `duplicate_control_name` finding
(`src/modules/test-writer/findings.ts`).
