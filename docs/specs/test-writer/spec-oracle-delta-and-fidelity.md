# Spec: Oracle delta + scenario fidelity — what the-internet run taught us

**Created:** 2026-08-18
**Updated:** 2026-08-18 — §1.2 from Kaizen-on-Kaizen (state, removals, settle, no-action)
**Updated:** 2026-08-18 — §1 and §5 built (Batch 1a) with the real-browser measurement below;
§2 built (Batch 1b); §3 and §4 built (Batch 2, which absorbed Batch 3's two report fixes); §2.2
added from run 2 and built
**Status:** Built — all of §1–§5. Remaining follow-up: HTTP Basic credentials as a suite setting
(separate spec) and hardening discover oracles from harvested deltas.
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

### 1.1 As built (2026-08-18)

`src/modules/execution-engine/delta.ts` + the worker's `executeStep`.

- **The baseline lives in Node, not on `window`.** Stashing it in the page would lose it to every
  navigation, and the single most valuable case — an invalid sign-in that re-renders the same page
  plus a flash message — is a navigation. Keys come back to the worker and go in as an argument.
- **Identity is a key, not a node:** `tag|role|ownText|href|value`. Own text, never `innerText`,
  because with `innerText` every ancestor of a new node also "changes" and the delta grows up the
  tree until it contains `<body>` — at which point restricting resolution to it means nothing.
  Comparison is a multiset, so a second identical row counts as new.
- **One `page.evaluate` function serialised twice** (baseline pass and diff pass), so both sides
  compute keys identically by construction. No `new Function`/eval — a page with a strict CSP
  would refuse it.
- **The match is deterministic** (`pickDeltaMatch`): word overlap first, then the tie-breaks that
  encode what a person means by "the message" — prose over a one-character "×", and the role the
  sentence asked for. No model call: reintroducing one per assertion is the cost this whole
  mechanism removes.
- **An empty delta is re-diffed once** at assertion time before it fails, so async rendering
  (a spinner finishing, an SPA route settling) is not mistaken for "nothing happened".
- **Dialog-only changes are separated out.** The worker auto-accepts native dialogs, so an alert
  leaves the page identical. That still fails the assertion — nothing was proven — but with
  `DialogOnlyChange`, which is explicitly NOT an app defect: the limitation is ours. Only
  `AssertionNothingChanged` reaches §5.
- **`delta_summary` is written to the run timeline** (`run_events`, "what changed: …") rather than
  a new `step_results` column — the same evidence for the reader and the same harvest for us,
  without a migration.
- **Nothing changes for a normal customer run:** `enabled` is false unless the test actually
  carries an `oracleScope: 'delta'` step, so no snapshots are taken.

> **Measured against the real site, 2026-08-18** (headless chromium, the-internet.herokuapp.com):
> | page | action | delta | resolves to |
> |---|---|---|---|
> | `/add_remove_elements/` | click "Add Element" | `button "Delete"` | the control it created |
> | `/javascript_alerts` | click "Click for JS Alert" | `p "You successfully clicked an alert"` | the result line — **not** the button that used to satisfy it |
> | `/login` (invalid) | submit | `div "Your username is invalid!"`, `a "×"` | the flash text, not its close button |
> | `/context_menu` | right-click the hot spot | **empty** | fails: "nothing on the page changed" |
> | `/dynamic_controls` | click "Remove" | `button "Add"`, `p "It's gone!"` | the confirmation message |
>
> Four of the five false passes in the run that prompted this spec are answered directly by that
> table; the fifth (the download link) has no delta and now fails.

### 1.2 What Kaizen-on-Kaizen taught (2026-08-18, runs 3–5 of `spec-screen-discovery.md`)

- **State is identity.** The key gains `|state` (`aria-pressed/selected/checked/expanded/current`,
  `aria-disabled`, `disabled`, `checked`). A filter button that becomes pressed, a tab that becomes
  selected, a Save that becomes enabled — each is the element the action changed. Before this, a
  filter on Kaizen's own Runs view was "nothing changed" (rows were only *hidden*, and hiding adds
  nothing).
- **Removals count.** `walk()` returns `removed` — baseline keys with fewer occurrences now. Nothing
  added but something gone (rows filtered, a banner dismissed, an item deleted) is a change; the
  assertion is then checked against the whole page with a log line saying why, instead of
  `AssertionNothingChanged`.
- **The DOM settles before the after-snapshot** (`settleDom`, 400 ms quiet / 2 s ceiling), and again
  before the re-diff at assertion time. A click returns before the app that fetches has answered.
- **A discover oracle with no action before it fails** — `AssertionNoAction`, "no action came before
  this check on this page". Its definition is *what the previous action changed*; with none, page-wide
  resolution passed on whatever it found. That is how the vacuity probe (navigates + assertions,
  actions removed) called every delta-scoped test vacuous — seven of seven in run 5 — and how a test
  could be green while checking nothing. Filed as the test's defect, never the app's; the validation
  runner names it in plain words.
- The delta oracle makes the vacuity probe redundant for description-target assertions by
  construction; the probe still catches literal-value assertions that were true before the action.

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

### 2.1 As built (2026-08-18)

- **Chrome is computed, not stored.** `getGroundingElements` derives it in the same query: an
  element whose role+name appears on ≥ 60 % of the suite's crawled pages (and ≥ 5 pages crawled)
  is chrome. Read-side means it is always consistent with the current crawl and needs no migration
  or second write pass. Chrome also ranks **last** within its kind under the per-page cap, so when
  the cap bites it is the page's own controls that survive.
- The writer prompt marks those rows `:: SITE-WIDE (nav/footer) — context, not what this page is
  about`, and HARD RULE 9 tells the model to stay on the plan and to start with a `navigate`.
- **The planner is not changed:** it never sees elements (it plans from page purposes and
  capabilities), so there is nothing there to mark. The drift happened in WRITE, and that is where
  the marker, the judge dimension and the gate now sit.
- **`checkChromeOnly` is a repair instruction, not a rejection** — consistent with
  spec-judge-repair-loop: the scenario gets one more attempt, on the frontier tier, with the
  page's own controls named for it ("for example: searchbox \"Search\"…"). Only a second failure
  ends the scenario.
- **Judge D5 `plan_fidelity` is HARD** and the judge body now carries `plan outline:` and
  `planned for page(s):` per scenario. The verdict rule becomes "PROPOSE when all three HARD
  dimensions pass"; a drift that is still writable from the given elements is a REVISE, so it
  rides the existing rewrite round rather than dying.
- **`prependNavigate`** runs after the schema gate and before render, so the sentence a human
  reviews and the AST the worker runs both contain it. A Tier-2 negative's `failStepIndex` moves
  with the inserted step.
- **Page text for control-less pages moves to Batch 2**, with the nearby-text names (§3): both are
  changes to what recon captures, and they belong in one pass.

### 2.2 What the second run taught (2026-08-18, run 2: 9 proposed / 2 proven / 19 rejected)

The delta oracle worked — every proposed test bound to what the action produced, and the login
negatives showed the picked flash text next to its "×". Yield did not move, and most of the loss was
self-inflicted:

- **Page text became an escape hatch.** Offered alongside a full element list, it answered twelve
  different plans with "navigate to the home page, verify 'Welcome to the-internet' is shown"; dedup
  ate eleven. Fix: page text goes to WRITE **only when the element list is empty**, and the schema
  gate rejects a scenario that never interacts on a page that has controls.
- **`select` was lumped in with `type`** by the "don't assert what you typed" rule — but reading back
  the option you chose IS the dropdown's oracle. Exempted.
- **A 260-character `assert_text` was rejected**, killing a sound status-codes test. It is a substring
  check, so the first sentence proves the same thing; the gate now trims instead.
- **No `assert_not_checked`** existed, so the writer improvised "verify the checkbox 1 is unchecked is
  not visible". Added, engine to template.
- **Three alert tests asserted dialog contents.** The writer is now told what the runner cannot see
  (dialogs are auto-answered; downloads are never opened; iframe internals are unreachable).
- **A no-action test was PROVEN.** "Hover Interaction" ran `navigate → verify text` green — hovering
  nothing — and the vacuity probe cannot catch it because there is nothing to remove. A scenario
  with no state-changing step is now labelled **PAGE LOADS**, never PROVEN, unless the assertion is
  about where the navigation landed (a redirect check is a real test).
- **`[data-kz-delta="kz-d-0"]` was unverifiable to a person.** The delta now rides as its own
  resolution source (`delta`); the run page opens "What changed after the action" with the picked
  row highlighted.
- The unlabelled-control finding still said "Kaizen cannot write a test that refers to them",
  contradicting the tests above it. Reworded.

What this run did NOT explain — and what the next spec addresses — is why 30 requested became 9:
the planner plans the whole app in one call from a compressed brief, and every stage after it can
only subtract. See `spec-planner-per-page.md`.

## 3. Names for the nameless (recon)

`deriveName` (spec-recon §4.0a) covers id/data-test. the-internet's checkboxes and inputs have
**no attributes at all**. Add the visible-text heuristic every screen reader user relies on:
adjacent text in the same parent (`<input type=checkbox> checkbox 1`), or the nearest preceding
label-ish text (≤ 40 chars). Captured by the surveyor as `attributes['nearby-text']`; `deriveName`
prefers it after `aria-label`. Unblocks checkboxes, inputs, dynamic_controls, key_presses.

**As built (2026-08-18).** The walk steps over inline separators (`br`, `span`, `label`, `small`)
and reads a heading that sits immediately before the control, stopping at any other form control —
walking into a neighbour's label is worse than having no name. Captured as an ATTRIBUTE, never as
the accessible name, so the accessibility finding still counts the control as unlabelled: the
screen-reader problem is real even once Kaizen's grounding problem is solved.

> Measured on the real site: `/checkboxes` → "checkbox 1", "checkbox 2"; `/dropdown` → "dropdown
> list"; `/dynamic_controls` → "a checkbox"; `/key_presses` → "target" (from its id, as before).
> `/inputs` still yields nothing — its number field has no adjacent text at all.

## 4. Recon correctness

- **Trailing slash.** Normalise for *identity* only; navigate to the **href as observed**. Store
  both (`url_normalized`, `url_observed`). Removes a false broken-link finding and recovers a
  whole page (`/add_remove_elements/`).
  **As built:** `LinkCapture.hrefObserved` carries the resolved href, the crawl frontier follows it
  (the seed keeps whatever the customer typed), `site_pages.url_observed` records where the browser
  actually landed, and the pipeline maps target pages, page paths and element page-urls through it
  on the way into WRITE — so a generated `navigate` step goes to a URL that answers 200. Identity
  stays normalised everywhere it already was.
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

**As built:** the worker records `error_type = 'AssertionNothingChanged'` and the validation runner
treats any `Assertion…` error type as assertion-class, alongside `LOGIC_FAILURE`. The finding then
reads *"at step N the page did not change at all after the action — the control responded to
nothing"*, and the rejection row says the same thing instead of "failed against the live site".
`DialogOnlyChange` is deliberately excluded: that failure is Kaizen's limit, not the app's.

## 6. Order and cost

Batch 1 (trust — the reason 5 of 10 were wrong): §1 delta oracle, §2 chrome + fidelity + navigate
+ hover, §5. Batch 2 (yield — more of the 40 pages become writable): §3 nearby-text names, §2
page-text for empty pages, §4 trailing slash. Batch 3 (report quality): §4 401 state + finding
collapse. Nothing here adds an LLM call; §1 removes candidates from the resolver's calls.

Success check: re-run the-internet with the same brief; expect ≥ 20 proposed, ≥ 15 proven, no
proposed test whose final assertion resolved to a button/link the action did not create.


## 7. Built — what landed where (2026-08-18)

| § | Change | Where |
|---|---|---|
| 1 | Delta oracle: snapshot → diff → resolve inside the change; empty delta fails | `execution-engine/delta.ts`, `workers/worker.ts` |
| 1 | Dialog-only changes separated from "nothing happened" | `worker.ts`, `validation-runner.ts` |
| 2 | Site chrome computed at read time, marked in the prompt, ranked last under the cap | `site-model.repository.ts`, `testwriter.gateway.ts` |
| 2 | Chrome-only scenarios get a rewrite instruction, not a rejection | `write/scenario-writer.ts` |
| 2 | Judge D5 `plan_fidelity` (HARD), with the outline and target pages in the body | `testwriter.gateway.ts`, `pipeline.ts` |
| 2 | Prepend `navigate`; `failStepIndex` moves with it | `write/scenario-writer.ts` |
| 2 | Hover is state-changing | `write/step-intent.schema.ts` |
| 2 | Page text for control-less pages; the plan is only rejected when there is neither | `recon/page-capture.ts`, `pipeline.ts`, gateway rule 10 |
| 3 | Nearby-text names | `dom-pruner`, `recon/derived-name.ts` |
| 4 | Trailing slash: navigate what the site wrote | `recon/*`, `site-model.repository.ts`, `pipeline.ts` |
| 4 | 401 → "behind HTTP authentication", with the realm | `recon/crawler.ts`, `findings.ts` |
| 4 | Console-error findings collapse at three or more | `findings.ts` |
| 5 | Delta failures are assertion failures → `possible_app_defect` | `validation-runner.ts` |

Migration `040_page_observed_url_and_text.sql` adds `site_pages.url_observed` and
`site_pages.page_text`.

**Not built here, deliberately:** `delta_summary` is written to the run timeline (`run_events`)
rather than a new `step_results` column — same evidence for the reader, same harvest for us, no
migration. HTTP Basic credentials as a suite setting remain a separate spec.
