# Spec: Oracle delta + scenario fidelity — what the-internet run taught us

**Created:** 2026-08-18
**Status:** Proposed — awaiting founder go
**Owner:** test-writer / worker
**Evidence:** the-internet.herokuapp.com, prod, 2026-08-18: 50 pages, 30 planned → 10 proposed
(1 proven, 9 needs review), 18 rejected, 116.6k tokens. Founder review of all 10 proposed +
18 rejected, run by run.

---

## 0. What the run actually said

Of the 10 proposed, **4 are good** (dropdown, the three login negatives). **5 passed for the wrong
reason** — the final "verify X is visible" resolved to a *button or link that was already there*
(the "Click for JS Alert" button, the download link, the "Remove" button, the footer link) instead
of the message the action produced. **1 drifted** — planned for `/inputs`, written against the
footer "Elemental Selenium" link that exists on every page, and named "Manipulate input text and
submit".

Of the 18 rejected, most were right; the ones that were ours: two scenarios had **no `navigate`
step** and started on the home page (JS Confirm, valid login); pages with **no interactive
elements** (404 page, javascript_error, nested_frames) were unwritable even though "verify the
text 'Not Found' is shown" is a fine test; **hover** is not treated as state-changing; the
password-reset 500 (a real app defect) was filed as "test failed" not "app defect".

Findings: the `/add_remove_elements` "broken link" is our **trailing-slash normalisation** bug
(404 without the slash, 200 with — we navigate to the normalised URL). 401 pages are "HTTP auth
required", not broken. Ten near-identical "page underneath was erroring" rows for one site-wide
console error.

The through-line: **the writer and the resolver both lack the notion of "what this action
changed."** Fix that once and five false positives, the drift, and the harvest all improve.

## 1. The delta oracle (worker) — the founder's proposal, made concrete

For a *discover oracle* (a description-target assertion following a state-changing step — the
only kind that can name something the crawl never saw), the answer must come from **what changed**.

- The writer already knows which assertions are discover oracles (description targets). Mark them:
  `StepAST.oracleScope = 'delta'` (set in `canonical-templates` for description-target assertions).
- The worker, before executing any state-changing step (click, type, select, check, press_key,
  click_random, drag, hover, right_click), takes a cheap **text snapshot**: `{ kaizenId, role,
  name, visibleText }` for visible elements (the pruner already tags `data-kaizen-id`; this is one
  `page.evaluate`, ~ms). After the step settles, it diffs: elements that appeared, or whose text
  changed, or that became visible. That set is the **delta**.
- For the next `oracleScope: 'delta'` assertion(s), resolution is **restricted to the delta**:
  candidates handed to the resolver are the delta's elements (plus their nearest text
  containers). If the delta is empty → the assertion **fails** with a precise reason:
  *"nothing on the page changed after 'click the Remove button' — there is no message to find."*
  Never falls back to the whole page: falling back is exactly how it found the button.
- The delta is also written to `step_results` (`delta_summary`: up to 10 `{role, name, text}`),
  which (a) shows in the run UI under the step ("What changed: 'It's gone!' appeared"), and (b)
  becomes the harvest for hardening discover oracles into specific text — free.
- Cost: one evaluate before and after state-changing steps only; zero LLM. If the resolver still
  needs the model, its candidate list is a handful of elements instead of the page.

Kills: JS-alerts (#2), context-menu (#3), download (#5), dynamic-controls (#10) false passes; makes
the login negatives resolve to the flash text instead of its "×" button.

## 2. Scenario fidelity (writer + judge)

- **Site chrome.** After recon, an element (role+name+href) present on ≥ 60 % of crawled pages
  (min 5) is marked `chrome: true` on the grounding row (`page_elements.attributes.chrome`). The
  writer prompt shows it as `:: SITE-WIDE (nav/footer) — not what this page is about`; the
  planner is told chrome is context, not a subject. Deterministic gate: a scenario whose only
  interacted elements are chrome is rejected: *"exercises only site-wide navigation, not the page
  it was planned for."* (Kills the "Manipulate input text" drift and the padded Elemental-Selenium
  tail in #10.)
- **Judge D5 — does what the plan says.** The judge gets the plan's `outline` and `targetPages`
  next to the steps and a fifth (HARD) dimension: the steps exercise the planned behaviour on the
  planned page. Otherwise REVISE with the plan restated as the instruction.
- **Always start somewhere.** If a scenario's first step is not `navigate`, the pipeline prepends
  `navigate to <targetPages[0]>` before render. Two proving runs died on the home page for want
  of this line.
- **Hover is state-changing** (`STATE_CHANGING` in the schema gate). It reveals captions.
- **Pages with no controls are still testable.** Writer gets the target pages' title + headings +
  first ~300 chars of visible text as `PAGE TEXT`; empty grounding no longer rejects the plan when
  the page has text; the schema gate already allows `navigate → assert_text/assert_title`.
- **The writer is told what Kaizen cannot see:** downloaded files, native dialogs' contents (they
  are auto-accepted), and iframes' internals (unless a frame step exists). No test may assert on
  those.

## 3. Names for the nameless (recon)

`deriveName` (spec-recon §4.0a) covers id/data-test. the-internet's checkboxes and inputs have
**no attributes at all**. Add the visible-text heuristic every screen reader user relies on:
adjacent text in the same parent (`<input type=checkbox> checkbox 1`), or the nearest preceding
label-ish text (≤ 40 chars). Captured by the surveyor as `attributes['nearby-text']`; `deriveName`
prefers it after `aria-label`. Unblocks checkboxes, inputs, dynamic_controls, key_presses.

## 4. Recon correctness

- **Trailing slash.** Normalise for *identity* only; navigate to the **href as observed**. Store
  both (`url_normalized`, `url_observed`). Removes a false broken-link finding and recovers a
  whole page (`/add_remove_elements/`).
- **401 + `WWW-Authenticate`** → page state `requires_http_auth`, finding *"…is behind HTTP auth —
  add credentials in suite settings"*, never "broken link". (Credentials themselves: separate
  spec, founder already briefed.)
- **Console-error findings collapse**: same message signature on ≥ 3 pages → one finding *"a
  console error appears on N pages (site-wide): <first line>"* with the page list in evidence.

## 5. Defects are defects

A discover-oracle assertion that fails because *nothing matched* is an assertion failure, not an
"element not found" plumbing failure — `oracleScope: 'delta'` failures join
`ASSERTION_FAILURE_CLASSES`. The password-reset 500 becomes the `possible_app_defect` finding it
should have been.

## 6. Order and cost

Batch 1 (trust — the reason 5 of 10 were wrong): §1 delta oracle, §2 chrome + fidelity + navigate
+ hover, §5. Batch 2 (yield — more of the 40 pages become writable): §3 nearby-text names, §2
page-text for empty pages, §4 trailing slash. Batch 3 (report quality): §4 401 state + finding
collapse. Nothing here adds an LLM call; §1 removes candidates from the resolver's calls.

Success check: re-run the-internet with the same brief; expect ≥ 20 proposed, ≥ 15 proven, no
proposed test whose final assertion resolved to a button/link the action did not create.
