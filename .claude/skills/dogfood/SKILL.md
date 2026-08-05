---
name: dogfood
description: Run Kaizen against itself as an adversarial QA engineer — hunt false-passes, not happy paths. Compiles NL tests through the live API, runs them, and judges expected-vs-actual with a bias toward catching tests that PASS when they should FAIL. Use when the user says /dogfood, "dogfood kaizen", "QA the engine", or wants adversarial coverage of a capability.
---

# Dogfood

Behave like a skeptical QA engineer, not a demo author. The goal is to find **false-passes** — a run reported green that should have been red. A battery where everything passes is a *failed* battery: it means the adversarial cases weren't sharp enough.

## Preflight
- `docker info` — if the daemon is down, say so and stop (Postgres/Redis run as bare containers).
- Confirm the API and worker are up (`npm run dev`, `npm run dev:worker`) and reachable.
- Read `KAIZEN_KEY` from the environment or `.env`. **Never hardcode the key into a file.**

## Harness
For each case: POST the natural-language test to the run API with the key, poll the run to a terminal state, and capture per-step `status` + `resolutionSource` (`src=`). Then a judge step compares the run's verdict against the case's *expected* verdict.

## Adversarial categories (always include these — not just happy paths)
1. **Polarity flips** — "verify page CONTAINS '<string-that-does-not-exist>'" MUST fail. "verify page does NOT contain '<visible-string>'" MUST fail. (This class caught BUG A: the compiler flipped `assert_text` → `assert_not_text`.)
2. **Hidden / script text** — assert on a string that exists only inside a `<script>` or a `display:none` node → MUST fail (scanners use visible `innerText`).
3. **Cache honesty** — run a passing test twice. The second run's resolved steps should show `src=redis` / `db_exact` AND still pass against the LIVE DOM. Then poison and confirm it fails — see `/cache-honesty`.
4. **Wrong-element** — target a description that matches multiple elements, or none. Confirm it doesn't silently resolve to the wrong one and pass.
5. **Attribute / state / count** — `assert_attribute` on a live IDL value (e.g. an input's typed value), `assert_count` with an off-by-one N → MUST fail.

## Judge rules
- A case only "passes the battery" when run-verdict === expected-verdict.
- Flag LOUDLY any case that passed but should have failed — that is a false-pass, the highest-severity finding.
- Report: N cases, N battery-passes, and every mismatch with the step + `src=` + why it's wrong.
- Do NOT soften a false-pass into "mostly works." Name it a defect and root-cause it to a layer (compiler / resolver / executor / cache).

## After
If defects are found: root-cause to a `file:line`, propose the fix, and — only if asked — fix on a branch (`fix/scope/...`). Record any new false-pass class in memory so the battery grows over time.
