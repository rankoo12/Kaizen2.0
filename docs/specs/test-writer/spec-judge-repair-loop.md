# Spec: Judge repair loop — reject less, rewrite more

**Created:** 2026-08-17
**Updated:** 2026-08-17 — judge tier finding recorded in §2.1
**Status:** Proposed
**Owner:** test-writer
**Amends:** `spec-generation-pipeline.md` §4 (gate stack), `spec-testwriter-ux.md` (rejection list)

---

## 0. The symptom

Repeated observation across several real analyses (saucedemo, 2026-08-17, authenticated scope):
the plan is good — "Add product to cart", "Remove product from cart", "Sort product listing",
"Open and close the menu" are exactly the tests a QA engineer writes for that app — and the
delivery is **zero tests**. Nine planned scenarios, nine rejected: 3 schema, 1 dedup, 5 judge.
The user's read is right: "it has the right idea but I don't receive tests."

The pipeline is losing tests it should ship, and the losses are concentrated in one place.

## 1. Diagnosis

### 1.1 The judge does not know what `{{selectedItem}}` is (defect)

`click_random` captures the clicked item's name into a run variable (`captureAs`, default
`selectedItem`), and the catalog's cart archetypes close the loop with an assertion on that
capture: *click a random add-to-cart button → open the cart → verify the text "{{selectedItem}}"
is shown*. That is the correct oracle for a cart — the strongest one available without knowing
prices.

The judge prompt (`testwriter.gateway.ts` `judgeScenarios`) never mentions captures. Reading the
rendered steps cold, a mini-tier model sees a literal `{{selectedItem}}` string and reasons "the
assertion relies on a variable that should be populated by the action, not a dynamic response" —
which is verbatim what it said when it REJECTED both cart tests on saucedemo. The two most
valuable tests in the plan died to a vocabulary gap.

### 1.2 The judge is stricter than the spec asks (over-fit)

"Open and close the menu → verify the menu is visible" was rejected as *"only checks the
visibility of the menu without validating the intended behavior"*. Making a hidden menu visible IS
the intended behaviour; the pre-state test in D1 passes (the menu was not visible before the
click). The prompt's BAD examples are all "presence of static structure", and the model has
generalised that to "any visibility assertion". It needs a GOOD example that is a visibility
toggle.

### 1.3 A judge REJECT is terminal, but the spec said it rides a repair round (divergence)

`spec-generation-pipeline.md` §4.6: *"Verdicts PROPOSE / REVISE / REJECT; REVISE rides the
single repair round."* As built (`pipeline.ts` JUDGE block), REVISE passes straight through and
REJECT drops the scenario. Nothing is ever repaired on the judge's feedback. Meanwhile the schema
gate — a *cheaper* gate catching *shallower* problems — does get a repair round.

So the gate that reasons about *value* has no path to improve a scenario; it can only kill it.
"Sort product listing → verify the url contains 'sort'" was a weak oracle on a good scenario. The
judge's reason ("does not check a behavior resulting from the sort action, merely the URL") is a
precise rewrite instruction. It was recorded and the scenario discarded.

### 1.4 The schema repair round is asked of the same model that failed (structural)

Three saucedemo scenarios died to *"cannot type a 'link' element"* — twice each. The writer was
told, in the repair prompt, exactly which step and why, and produced the same shape again. Both
attempts run on the mini tier. When a mini model fails a repair instruction once, the second try
should not be a coin flip on the same model.

### 1.5 We throw away the evidence (observability)

`ScenarioRejection` carries `name`, `stage`, `reason`. Not the steps. When the judge rejects, no
one — not the user reading "Kaizen shows its work", not us calibrating the judge — can see what
was actually written. This spec's diagnosis of 1.1 rests on the judge's *reasons*; the steps
themselves are gone. That is the wrong thing to lose.

## 2. What ships

### 2.1 Judge prompt: captures and toggles

Add to the D1 block of `judgeScenarios`:

- A definition: `{{selectedItem}}` (and any `{{name}}` that appears after a `click a random …`
  step) is a value CAPTURED at run time from the element that was clicked. An assertion that
  the captured text is shown somewhere *else* (a cart, a detail page, a confirmation) after a
  state-changing action is a strong, causal oracle — it fails if the wrong item was added or
  the page ignored the click. It is not "checking a variable".
- GOOD example: *click a random add-to-cart button → click the cart link → verify the text
  "{{selectedItem}}" is shown.*
- GOOD example: *click the "Open Menu" button → verify the "Logout" link is visible* (a
  visibility TOGGLE is a genuine delta when the element was hidden before the action; only
  presence of the page's static structure is vacuous).
- Verdict guidance: when D1 fails but the ACTIONS are a real user task and only the ORACLE is
  weak, the verdict is **REVISE**, not REJECT, and `reason` must say what to assert instead.
  REJECT is for scenarios that cannot be rescued by a better assertion (no state change at
  all; page-poking; a premise the app doesn't support).

The verdict rule text becomes: PROPOSE when both HARD pass and at most one SOFT fails; REVISE
when the actions are sound but the oracle is not, or when both SOFT fail; REJECT when the
scenario exercises nothing.

> **Measured 2026-08-17 (first PR).** With the vocabulary above in place, the judge was probed
> directly with the five saucedemo shapes (cart-with-capture, remove-with-capture, open-menu,
> sort-asserting-url, static-heading), two rounds each:
> - **mini (gpt-4o-mini):** REJECTED "Add product to cart" and "Open and close the menu" in
>   *every* round, with reasons that contradict the GOOD examples in its own prompt verbatim.
> - **frontier (gpt-4o):** PROPOSED cart, remove and menu; REVISE/REJECT for sort-by-url;
>   REJECT for the static heading — all five correct, both rounds.
>
> So the judge **moves to the frontier tier**. It is one batched call per job (~1–2k tokens),
> the cheapest frontier call in the pipeline, and the one that decides whether the user gets
> anything at all. `model-tier.ts` now reads three frontier calls per job. The REVISE-instead-of-
> REJECT verdict guidance is deferred to the repair-loop PR (§2.2), where REVISE has somewhere to go.

### 2.2 The judge repair round (REVISE → rewrite → re-judge)

In `runGenerationPhases`, after the first judge call:

1. Partition verdicts: PROPOSE → survivors. REVISE and REJECT-with-a-fixable-reason → **repair
   set**. (In v1, treat every non-PROPOSE as the repair set; the judge's own reason is the
   rewrite instruction. Bounded by the plan size, ≤ 10.)
2. For each scenario in the repair set, call `writer.write(...)` once more with a new input,
   `judgeFeedback: string[]` — the failed dimensions' reasons — which the gateway renders in the
   user prompt as *"A QA reviewer rejected your previous version. Fix exactly this: …"* together
   with the previous rendered steps, so the model edits rather than reinvents. This is a
   *rewrite*, not a second generation: it keeps the plan, grounding and archetype.
3. Rewritten scenarios go through the same schema/safety/render gates (they are new intents),
   then are **re-judged in one batched call**. PROPOSE → survivors; anything else → rejected
   with stage `judge` and both reasons on the report (`reason: "after one rewrite: …"`).
4. Dedup is not re-run (rewrites keep their action set by construction; only the oracle moves).

Cost: at most one extra `generateScenario` per non-PROPOSE scenario and one extra judge call per
job. On the saucedemo job that is ~5 writes + 1 judge ≈ 8–12k tokens, against a job that spent
~10× that on recon and planning to deliver nothing.

Metric: `testwriter.judge_repair_attempted`, `testwriter.judge_repair_rescued`. Report gains
`write.judgeRepaired: number` (how many came back PROPOSE after a rewrite).

### 2.3 Repair rounds escalate the tier

`generateScenario` gains an optional `tier?: 'mini' | 'frontier'` on its input; the writer passes
`'frontier'` on **any repair attempt** (schema round 2, known-entity round 2, judge rewrite). First
attempts stay mini. Rule of thumb, stated in the interface doc: *the first draft is cheap; the
second draft is the expensive one, because it is the last.*

Cost: bounded to scenarios that failed once. Historically ~30–50% of a plan; frontier write is
~2–3k tokens each.

### 2.4 The writer is told what is NOT there

Before calling the model, the writer computes which input roles exist in `grounding`. If no
element has a typeable role (`textbox`, `searchbox`, `combobox`, `spinbutton`), the user prompt
carries one line: *"There is NO typeable field on these pages. Do not include a type step; if the
scenario needs one it cannot be written — return the closest scenario that does not type."*
Same for `select` (no combobox/listbox) and `check` (no checkbox/radio/switch). Deterministic,
zero-token, and it addresses the exact failure that burned six writer calls on saucedemo (a
search test on an app with no search box).

### 2.5 Rejections carry the steps

`ScenarioRejection` gains `steps?: string[]` (rendered canonical text at the moment of
rejection). Filled for every stage that has steps: schema-final (the last attempt's steps if the
schema gate parsed them; else omitted), safety, render, dedup, judge, validation. The rejection
list in the writer UI gets a per-row disclosure that shows them, so "Kaizen shows its work" means
the work, not only the verdict.

Also: the UI's copy for `schema` currently reads *"Referenced an element the crawl never saw"*
regardless of the actual error. Change to *"Couldn't be grounded in what the crawl saw."* — the
specific reason follows anyway.

### 2.6 Findings: SPA 404s are not broken pages (small, separate PR)

saucedemo serves HTTP 404 for every deep route and renders the app client-side. Recon recorded
`inventory.html responded 404` as *"A page on your site could not be opened"* — while the same
report lists that page's elements. `reconFindings` should downgrade an error page to LOW with the
text *"responded 404 but rendered a page with N interactive elements — probably a single-page app
whose server returns 404 for deep links; some crawlers and link checkers will treat these as
broken"* whenever the captured page has ≥ 1 element or a title. Not a false positive erased — the
status *is* 404, and it is worth knowing — but not the top-ranked, wrong headline it is today.

## 3. Out of scope (recorded so it is not re-derived)

- A deterministic capability check at PLAN (dropping "search" scenarios when no page has a
  search capability). Worth doing; not the cause of the zero-delivery. Left for the knowledge
  mission where capabilities become structured.
- Making dedup semantic. "Navigate next in pagination" ≡ "Sort product listing" was a correct
  call given both had degenerated to navigate-only action sets; the fix upstream (2.2) is what
  makes both non-degenerate.

## 4. Done when

Re-running the saucedemo authenticated analysis locally with an identical plan produces ≥ 3
proven drafts (add-to-cart, remove-from-cart, open-menu are the ones this spec expects to
rescue), the rejection list shows steps per row, and the frontier tier is billed only for repair
attempts (`billing_events` purpose `generateScenario` split by model).

## 5. Files

- `src/modules/llm-gateway/testwriter.gateway.ts` — judge prompt (2.1), `tier` + `judgeFeedback` +
  `absentRoles` in `generateScenario` (2.3, 2.4).
- `src/types/test-writer.ts` — `WriteInput.tier`, `WriteInput.judgeFeedback`,
  `WriteInput.previousSteps`, `ScenarioRejection.steps`.
- `src/modules/test-writer/write/scenario-writer.ts` — tier escalation, `rewrite()` entry point
  for the judge round, absent-role notice.
- `src/modules/test-writer/pipeline.ts` — the repair round; steps on rejections; report counters.
- `src/modules/test-writer/findings.ts` — 2.6.
- `packages/web/src/components/design/screen-writer.tsx` — steps disclosure, schema copy.
- Tests: `scenario-writer` (tier per attempt, absent-role line), `pipeline` (REVISE→rewrite→
  re-judge, REJECT after second verdict, PROPOSE untouched), `findings` (SPA downgrade).
