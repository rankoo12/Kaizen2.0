# APP-KNOWLEDGE.md — Kaizen (black-box exploration)

**Explored:** 2026-08-21 · `http://localhost:3001` · headless Chromium via Playwright scripts
**Method:** No source code, docs, specs or DB were read. Everything below was observed by driving the real running app in a browser and watching the DOM and network traffic.

---

## 1. What the application is

**Kaizen — "The QA Brain"** (browser tab title: `Kaizen — The QA Brain`).

It is a **SaaS for AI-driven UI test automation**. The pitch, taken from its own on-screen copy:

> "WRITE IT IN ENGLISH — KAIZEN FINDS THE ELEMENTS AT RUN TIME"
> "No selectors, no waits, no code."

A user writes a test as an ordered list of **plain-English steps**. At run time Kaizen resolves each step to a real DOM element. Crucially, it **remembers** every element it has ever resolved in a store called **The Brain**, so repeat runs cost **0 AI tokens**. The product's central economic claim is surfaced everywhere in the UI:

> "A lookup on a page Kaizen already knows costs 0. Anything new goes to the AI once, then settles there too."
> "The line that matters: a mature test should cost close to nothing."

Secondary capability: **self-healing**. When a remembered selector stops working, Kaizen tries to re-learn it mid-run so the test passes anyway; the run is then marked *healed* rather than *failed*.

### Domain model (inferred from URLs and UI)

```
Tenant / Workspace  (d2bf87a1-…)   — owns everything; has a monthly token budget
 ├── Members        (owner role)
 ├── API keys       (scoped, for CI)
 ├── Suites         — a named group of test cases
 │    └── Cases     — "tests": name + baseUrl + ordered English steps
 │         └── Runs — an execution of a case; has steps, timings, tokens, screenshots
 ├── Analyses/Jobs  — "explore this app and propose tests" background jobs
 └── Brain entries  — learned element resolutions (WORKSPACE scope or GLOBAL scope)
```

### API surface observed (via the Next.js proxy)

| Method | Path | Meaning |
|---|---|---|
| `GET` | `/api/auth/me` | session probe; `401` when signed out |
| `POST` | `/api/auth/demo` | demo sign-in |
| `POST` | `/api/auth/login` | credential sign-in; `401` on bad creds |
| `POST` | `/api/auth/logout` | sign out |
| `GET` | `/api/proxy/suites` | list suites |
| `POST` | `/api/proxy/suites` | create suite → `{name}` |
| `GET`/`POST` | `/api/proxy/suites/:id/cases` | list / create test (`201`) |
| `GET` | `/api/proxy/suites/:id/jobs` | analysis jobs for a suite |
| `GET`/`PATCH`/`DELETE` | `/api/proxy/cases/:id` | read / edit (`PATCH`) / delete (`204`) |
| `POST` | `/api/proxy/cases/:id/run` | queue a run → `202 {runId, status:"queued"}` |
| `GET` | `/api/proxy/runs?limit=50` | run feed |
| `GET` | `/api/proxy/runs/:id` | one run |
| `GET` | `/api/proxy/tenants/:id/members` · `/usage` · `/usage/history?days=30` · `/keys` | workspace data |
| `GET` | `/api/proxy/media?key=gs://…` | screenshot bytes |

---

## 2. Global shell and navigation

The app is a **desktop-style single-page application**. It presents itself as a windowed app (`div.win`) with a **menu bar**.

> ### ⚠ The single most important fact for writing tests
> **The URL never changes.** Every screen — Runs, The Brain, Settings, the test composer, run detail — renders at **`http://localhost:3001/tests`**. Navigation is pure client-side view-swapping. **Never assert on `page.url()` to verify in-app navigation**; assert on the heading/content of `<main>` instead. Only `/login`, `/signup` and the auth redirect are real URLs.

### Menu bar

| Menu | Items |
|---|---|
| **File** | `New Test ⌘N`, `New Suite`, `Analyze an app…` |
| **View** | `Tests ⌘1`, `Runs ⌘2`, `Analyses ⌘3`, `The Brain ⌘4`, `Usage ⌘5`, `Next appearance ⇧⌘A`, `Hide sidebar ⌥⌘S` |
| **Account** | `test@test.com` (label), `Usage & settings`, `Sign out` |
| **Help** | Non-interactive hint: `Keyboard: ⌘N new · ⌘R run · ⌘1–4 screens` |

Menu items are `button.menu-item`. `Escape` closes an open menu.
**Quirk:** `File ▸ New Suite` does **not** create a suite — it opens the New-test composer. Suites are actually created from the composer's `+` button (§5.2).

### Sidebar

`WORKSPACE` header, then `Tests` with a total count, then one row **per suite** with its case count, then `Runs`, `Analyses`, `The Brain`, `Usage`, `Settings`, and the signed-in user chip (`DU · Demo user`).

- Clicking a **suite** scopes the Tests screen to that suite: heading becomes the suite name, and a **`Run suite`** button plus a *"What Kaizen knows about this app / v1 / 4 of 30 known pages have a test"* panel appear.
- The sidebar is an `<aside>`; `View ▸ Hide sidebar` removes it from the DOM entirely (`document.querySelectorAll('aside').length === 0`) and the `WORKSPACE` text disappears.

### Keyboard shortcuts (all verified working)

`⌘1` Tests · `⌘2` Runs · `⌘3` Analyses · `⌘4` The Brain · `⌘5` Usage · `⌘N` new test · `⌘R` run · `⇧⌘A` cycle appearance.
Row list also advertises `↑↓ move`, `⏎ open latest run`.

---

## 3. Authentication

### `/login`
Heading **"Sign in to Kaizen"**, subtitle *"Your tests have been running while you were away."*
Controls: Email (`you@company.com`), Password (`••••••••`), **Sign in**, **Demo user**, **Create a workspace**.

- **Demo user** → `POST /api/auth/demo` → lands on `/tests` as `test@test.com`, workspace "Kaizen", role **owner**.
- Demo blurb: *"Look around a real workspace without signing up. Runs are disabled on the demo account, so nothing you click there spends tokens."*
  **⚠ Observed contradiction:** runs are **not** actually disabled. Clicking *Run now* on the demo account returns `202 {status:"queued"}` and the run really executes (I saw a queued run later appear as `PASSED · 5.20s`). This copy is inaccurate — a genuine finding.
- Bad credentials → `401` and the inline message **"Invalid email or password"**; stays on `/login`.
- Footer: *"Sessions are cookie-based, so you stay signed in on this device."*

### Auth guard
Visiting `/tests` signed-out redirects to **`/login?next=%2Ftests`** (destination preserved). Visiting `/` redirects to plain `/login`.

### `/signup` — "Create your workspace"
Fields: Your name (`Ada Lovelace`), Email, Password (`· 8 characters or more`), Confirm password. Buttons: **Create workspace**, **I already have an account** (→ `/login`).
Validation is **client-side only — no network request is made** when it fails:
- passwords differ → **"Those passwords don't match."**
- password < 8 chars → **"Use at least 8 characters for the password."**

### Sign out
`Account ▸ Sign out` or Settings ▸ Appearance ▸ **Sign out** → `POST /api/auth/logout` → redirect to `/login`.

---

## 4. The Tests screen (default)

Heading `Tests`, sub-line `N TESTS ACROSS M SUITES`.

**Filter tabs:** `All`, `Failing`, `Healed`, `Passed`, `Drafts N`.
Verified semantics — each returns a genuinely different row set:
- `Failing` → only `FAILED` badges.
- `Passed` → `PASSED` (includes the passed DRAFT).
- `Drafts` → only rows carrying the `DRAFT` badge.
- `Healed` → empty in this workspace (0 rows) with an empty state.
- `All` → everything, statuses `FAILED / PASSED / PENDING / DRAFT`.

**Search box** `Search tests` — live client-side filter on the test name. No match → empty state **"No tests match / Try a different filter, or write a new test in plain English."**

**Health tiles:**
- `Suite health` — a percentage + `Green`, e.g. *"5 passed clean, 0 healed themselves, 9 need a human."*
- `Needs a human` — count, labelled `tap to filter`; clicking it filters the list to the failing tests.
- `Self-healed` — count, *"no one fixed a selector"*.
- `From memory` — `%` *"of last runs cost 0 tokens"*.

**Banner** (when the last analysis produced nothing): *"Your last analysis proposed nothing — the reasons are in its report."* + **See why** → opens the analysis report (§8).

**Table columns:** `TEST | MEMORY | COST · TOK | STATUS | LAST RUN`.
When *Group tests by suite* is on (default), rows are grouped under suite headers; the `Demo` suite shows a `· scratch` marker.

### Row anatomy — important for automation
Rows are **`div.row.focus-row[tabindex=0]`**, *not* `<table>` rows. The name lives in `div.row-t` (with `title` attribute); the target/owner in `div.row-s`.

- **Clicking a test row does nothing.** (Verified: no navigation, no drawer.) This differs from the Runs screen, where rows *are* clickable.
- Actions live in `div.row-actions`, revealed on hover:
  - button 0 — `title="Run now (⌘R)"` (play icon)
  - button 1 — `…` overflow menu → **`Open latest run ⏎`**, **`Run now ⌘R`**, **`Edit steps`**, **`Delete test`**
- Status badges: `PASSED`, `FAILED`, `PENDING` (never run), `DRAFT`.
- A Kaizen-authored draft additionally shows a sparkle icon `aria-label="Written by Kaizen"` and extra row buttons **`Proof`** (`title="See the run that proved it"`) and **`Accept`**.
- `MEMORY` column shows e.g. `80%` with `title="80% of lookups came from memory"`; `COST` shows `free` with `title="First run cost 0 tokens to learn; latest cost 0"`.

### Delete flow (fully verified)
Overflow ▸ `Delete test` opens an **in-app confirmation** (not a native dialog) reading:

> **Delete "<name>"?**
> The test, its run history and its learned selectors are removed for everyone in the workspace. This can't be undone.
> `Cancel` · `Delete test`

- **Cancel** → row remains.
- **Delete test** → `DELETE /api/proxy/cases/:id` → `204`, row disappears.

---

## 5. The test composer (New Test / Edit steps)

Opened by **New Test**, `⌘N`, or `File ▸ New Test`. It is a **full screen view, not a modal**.

- New: heading `New test` / `WRITE IT IN ENGLISH — KAIZEN FINDS THE ELEMENTS AT RUN TIME`
- Edit: heading `<test name>` / `EDITING THE STEPS. RUN HISTORY AND LEARNED SELECTORS ARE KEPT.` (fields pre-filled; saving issues **`PATCH`**)

### 5.1 Fields
| Control | Notes |
|---|---|
| **Test name** | placeholder `Sign in with valid credentials`; input index 0 in `<main>` |
| **Suite** | `<select>` of all suites, plus a `+` button `title="New suite"` |
| **Target URL** | pre-filled with the literal `https://` |
| **Start from** | `Sign-in flow` · `Search a site` · `Blank` |
| **Steps** | one text input per step, placeholder `e.g. click the "Sign in" button`; first step pre-seeded `navigate to https://` |

Buttons: `Suggest tests`, `Cancel`, `Save`, `Save & Run`, plus a `Back` icon button.

**`Suggest tests` gating (verified):** disabled while Target URL is empty, `title="Enter the page URL first"`; once a URL is entered it becomes enabled with `title="Ask Kaizen what this page is missing"`.

Helper text: *"You can reference something an earlier step remembered with `{{name}}`, and steps that touch cookie banners or iframes are handled for you."*

### 5.2 Creating a suite inline — ⚠ contains a real bug
Clicking `+` replaces the suite `<select>` with a text input `placeholder="New suite name"`.

- **Pressing `Enter` works correctly:** `POST /api/proxy/suites {"name":…}`, the input reverts to a `<select>`, the new suite is **auto-selected** and appears in the sidebar.
- **🐞 BUG — blurring silently discards the name.** If you type a suite name and click away (blur) instead of pressing Enter, **no `POST /suites` is ever issued**. Saving then writes the case into **whichever suite happens to be first in the list** — silently, with no warning and no error. I reproduced this twice; my test landed in an unrelated suite belonging to another user. Data loss of intent + wrong-suite write.

### 5.3 Step list editing
Each step row has icon buttons `title="Move up"` / `"Move down"` / `"Remove"`, plus an `Add a step` affordance which is a **`div.row`, not a `<button>`** (so `getByRole('button', {name:'Add a step'})` will not find it).
All three verified to reorder/remove correctly and immediately.
Note: in `<main>`, inputs 0 and 1 are name and URL, so **step inputs start at index 2**.

### 5.4 The live compiler — the app's richest business logic
As you type, each step is classified into an **action kind** and a **resolution strategy**, shown both as a per-step chip and in a `Compiled plan` panel. A counter reads *"N need no lookup / M find an element"*.

**Strategies:** `PATTERN` → shown as `0 TOK` (free, deterministic); `LOOKUP` → must find an element, may cost tokens.

Verified classification map (probed with 35 phrasings):

| Phrasing | Kind | Strategy |
|---|---|---|
| `navigate to <url>`, `go to <url>`, `open <url>`, `reload the page`, `go back` | **NAVIGATE** | PATTERN (free) |
| `press Enter`, `press Tab` | **KEY** | PATTERN (free) |
| `scroll to the bottom` | **SCROLL** | PATTERN (free) |
| `wait for the spinner to disappear` | **WAIT** | PATTERN (free) |
| `click the "X" button`, `click X`, `tap the X button`, `hover over the menu`, `dismiss the cookie banner if it appears` | **CLICK** | LOOKUP |
| `type "x" in the Y field`, `enter "x" in …`, `fill the Y field with "x"` | **TYPE** | LOOKUP |
| `select "X" from the dropdown`, `choose "X" in the Y select` | **SELECT** | LOOKUP |
| `check the first checkbox`, `uncheck the Y checkbox` | **CHECK** | LOOKUP |
| `verify …`, `assert …` | **ASSERT** | LOOKUP |
| `drag the item onto the target` | **DRAG** | LOOKUP |
| `remember the order number as {{order}}` | **CAPTURE** | LOOKUP |
| `switch to the new tab` | **TABS** | LOOKUP |

**Fallback rule:** unrecognised text (`blah blah nonsense words here`, `take a screenshot`, `upload the file "a.png"`, `hit the Escape key`) is classified **CLICK / LOOKUP**. Note `hit the Escape key` is *not* recognised as KEY, unlike `press Enter` — a nice edge case.
**Empty step** → kind renders as `—` and the plan shows *"Write a step and it shows up here."*

### 5.5 Saving
`Save` → `POST /api/proxy/suites/:suiteId/cases` with `{name, baseUrl, steps[]}` → `201`. The app then **navigates to the new test's detail view**, which shows the empty state *"This test has never run / Run it once and every step, selector and screenshot shows up here."* + **`Run it now`**.
The new test then appears in the Tests list and is findable via search.
There is **no client-side validation**: `Save` is enabled even with an empty name and empty steps.

---

## 6. Run detail

Reached via a test row's `Open latest run`, or by clicking any row on the **Runs** screen.
Header: test name + `#<RUNID> · <HOST> · <TRIGGER>` (e.g. `#4ED322CB · THE-INTERNET.HEROKUAPP.COM · WEB`).

**Tabs:** `Steps` · `Line` · `Activity` · `History`, plus a **`Re-run`** button.

**Summary tiles:** `Passed/Failed`, `N steps · when`, `Duration` (with a delta vs last run, e.g. *"147ms slower than last"*), `Tokens spent` (*"was 0 last run"*), `From memory` (e.g. `3/3 needed no AI`), `Progress` (`5/5 steps`).

### Steps tab
`STEPS · IN ORDER, STOPS ON FIRST UNHEALED FAILURE`. Each step shows index, kind, the English text, a **source badge**, token cost, duration, and the **actual selector used** (e.g. `role=textbox[name="Username"]`, `#flash`, `#dropdown`).

**Source badges seen:** `CACHE`, `PATTERN`, `AI`, `CHANGED` (a delta-detected element, selector `[data-kz-delta="kz-d-0"]`).

Selecting a step opens a detail panel: `Evidence` (a screenshot, *"What the page looked like when the step finished. Click to enlarge."*), a feedback control **"Was this the right element?" → `Yes — pin it` / `No — block it`** (*"Pinning always reuses it; blocking retires the pattern for good."*), plus `How it was resolved`, `Selector used`, `Duration`, `Tokens`, `Candidates`.

For a failed step, a **`What went wrong`** block appears, e.g.:
> Healing ran (EscalationStrategy) but could not recover the step. · tried `body` · Attempts 1 · Strategies 1 · Healing time 0ms

### Line tab — "Production line"
A factory metaphor: *"The session moves down the belt. Machines that remember run for free; the one that has to think draws power."* Shows `3 FREE / 0 TOK DRAWN` and a legend: **From memory** / **Drawing power** / **Repaired itself** / **Broke down**.

### Activity tab
A chronological log that reveals the **resolution cache hierarchy** explicitly:
- `L0 · Archetype`
- `L1 · Redis cache`
- `L2 · Postgres exact`
- (and the AI as the last resort)

### History tab
`Cost per run` summary + a table `RUN | STATUS | DURATION | TOKENS | WHEN` of previous runs of the same test; the current one is marked `web · showing`.

---

## 7. Runs screen

Heading `Runs`, sub-line `N RUNS IN THIS WORKSPACE, NEWEST FIRST`.
**Filters:** `All`, `Active`, `Failed`, `Healed` — verified to produce different row sets (`Failed` → only FAILED; `Active`/`Healed` → 0 rows here).
**Tiles:** `RUNS SHOWN` (`50 of 129 total` — the feed is capped at 50 via `?limit=50`), `PASSED CLEAN`, `SELF-HEALED`, `FAILED`, `TOKENS`.
**Columns:** `TEST | STATUS | DURATION | TOKENS | TRIGGER | WHEN`; each row also shows `#runid` and `suite·host`. Trigger badge observed: `WEB`.
**Rows are clickable** and open run detail.

---

## 8. Analyses screen

Heading `Analyses`, sub-line `EVERY TIME KAIZEN EXPLORED AN APP AND PROPOSED TESTS`.
Tiles: `Analyses` (count), `Tests proposed`, `Spent writing`.
Columns: `APP | SUITE | STATUS | COST · TOK | WHEN`.

### The "Analyze an app" sheet
> ⚠ **Operational caution:** submitting this sheet starts a long-running background exploration job (2–20 minutes) that outlives a test session. It must only be opened, inspected and cancelled — **never started**. No test in this suite submits it.

Opened from `Analyze an app`, the Tests screen's `Analyze` button, or `File ▸ Analyze an app…`. It renders as an **overlay with `z-index: 60`, outside `<main>`**.

Copy: *"Kaizen explores it read-only, shows you a test plan, and writes only what you approve."*

Controls:
- **Suite** `<select>` + `New`
- **App URL** (`https://staging.your-app.com`)
- **Description** textarea — *"Describe your app — optional, but it makes the plan sharper"*, warning *"Don't paste credentials — they're detected and removed."*
- **`Allow tests that create throwaway data`** toggle — *"Off: signup and cart tests are still written, but proposed unproven instead of executed."*
- **`Signed-in exploration`** toggle — *"Let Kaizen sign in and explore as a user."*
- Collapsible **`What exploration does — and never does`** — expands to a paragraph promising it obeys robots.txt, stays on-domain, ~1 page/second, never submits forms, and never presses destructive buttons (delete/pay/publish/save); checkout tests "walk up to the payment step and stop".
- Collapsible **`▸ Advanced`** → expands (`▾`) to reveal **Exploration depth** `Quick 10` / `Standard 30` / `Deep 50`, a `Tests to plan` field, and toggles `Pause for my approval after planning`, `Prove each test with a real run`.
- `Cancel` · `Start exploring`

**Verified URL behaviour:**
| App URL | Production warning shown | `Start exploring` |
|---|---|---|
| `https://example.com` | ✅ *"This looks like a production URL…"* | enabled |
| `https://staging.example.com` | ❌ (shows the calmer staging hint) | enabled |
| `http://localhost:3000` | ❌ | enabled |
| *(empty)* | ❌ | **disabled** |

### Analysis report ("See why")
Opens `QA engineer — <suite>` with the failure reason and **`What Kaizen found — N things worth your attention`**: accessibility/quality findings each with a description, the URL, an element type, and a severity (`MEDIUM`). Example: *"2 checkboxes on this page have no readable label … a screen reader announces nothing for them."*

---

## 9. The Brain

Heading `The Brain`, sub-line `EVERY ELEMENT KAIZEN HAS LEARNED, AND HOW MUCH IT STOPS YOU PAYING`.

**Filters:** `All`, `Workspace`, `Global`, `Needs review`.
Verified arithmetic: **All (38) = Workspace (11) + Global (27)**; `Needs review` (4) is a cross-cutting subset flagged with a `NEEDS REVIEW` badge.

**Search:** `Search what it knows` — filters live. No match → *"Nothing matches"* plus the resolution-order explainer:

> "Kaizen resolves cheapest-first: known patterns, then this workspace's cache, then similarity search over past resolutions, then the global brain of verified selectors, and only then the AI. Every success is written back here."

**Tiles:** `Reliable` (`98%` — *"301 of 308 remembered resolutions held up. The rest triggered healing."*), `Learned elements` (`38`, *"27 from the global brain"*), `Avg confidence` (`0.90`), `Recalls` (`308`).

**Columns:** `WHAT IT MEANS · SELECTOR | SITE | SCOPE | CONFIDENCE | RECALLS | VERIFIED`.
Each entry pairs a natural-language intent (`type "tomsmith" in the Username field`) with the concrete selector (`role=textbox[name="Username"]`) and which tests use it (`+2 more`). Scope badges are `WORKSPACE` / `GLOBAL`. Unused entries read `ready, unused`; orphaned ones read `step since deleted`. Brain rows are **not** clickable.

---

## 10. Usage & Settings

`Usage` and `Settings` open the **same screen** (`Usage / SIGNED IN AS TEST@TEST.COM`) with sub-tabs **`Usage` · `API keys` · `Members` · `Appearance`**.

> **Quirk:** clicking the `Usage` sub-tab while on `Appearance` did not switch the panel back in my observation — the Appearance content stayed. Worth a regression test.

### Usage
Tiles: `Tokens this month` (`55,196 of 5,000,000`, *"spent on finding elements"*, `4,944,804 left this cycle`, `resets 1.9.2026`), `Runs this month`, `Free runs` (`100% — 50 of the last 50 cost nothing`), `Members`.
Business rule stated: *"Every workspace has a monthly token budget. Go over it and new runs are rejected the moment they're submitted, with the reason on the run, rather than failing halfway through."*
Chart: `Tokens per run · last 30 days`.

### API keys
Empty state: **"No API keys yet / Create one to trigger runs from CI."** Button **`New key`**. Columns `KEY | SCOPE | LAST USED | CREATED`.
Rules stated: *"Only the hash is stored, so a key is shown once and can't be recovered afterwards"*; *"Needs execute scope or higher — a read-only key is refused with 403"*; *"Running a saved test by id still requires a signed-in session rather than a key."*
A copyable `curl` snippet for `POST $KAIZEN_API/runs` is shown.

### Members
Columns `MEMBER | ROLE | JOINED`; one row: `Demo user (you) · test@test.com · owner · 5.8.2026`.
Rule: *"Members only ever see this workspace's data; roles decide who can author tests, trigger runs, and manage keys."*

### Appearance
- **Theme:** `Aperture` (default, *"the industrial skin"*), `Light`, `Dark`.
  Verified: sets **`document.documentElement[data-appearance]`** and persists **`localStorage['kaizen.appearance']`**. `⇧⌘A` cycles it.
- **`Group tests by suite`** — a `button[role=switch]` with `aria-checked`; persists `localStorage['kaizen.groupBySuite']` (`1`/`0`). Off → *"Off shows one flat list"*, and suite header rows disappear from the Tests list.
- **SESSION** block with `Sign out`.

---

## 11. Business rules observed

1. **Cost model.** Only *element lookups* can cost tokens. `PATTERN` steps (navigate, key, scroll, wait) are always `0 TOK`. A lookup on a known page is free; a new one goes to the AI once then "settles".
2. **Resolution order (cheapest-first):** known patterns → workspace cache (L1 Redis) → similarity search (L2 Postgres) → global brain → AI. Every success is written back to The Brain.
3. **Cache scopes.** Entries are `WORKSPACE` or `GLOBAL`; the global brain is shared verified knowledge (27 of 38 entries here came from it).
4. **Execution stops on the first unhealed failure** — but healing gets a chance first; a healed step lets the run continue and the run counts as *healed*, not failed.
5. **Drafts must be proven.** Kaizen-authored tests carry a `DRAFT` badge and a "Written by Kaizen" sparkle. Their proving run is labelled *"This is a proving run — Kaizen executed this draft to earn the right to propose it. It doesn't appear in your Runs feed."* (trigger `TESTWRITER`). Confirmed: *"drafts only appear after a green proof."* A human then clicks `Accept`.
6. **Token budget is enforced at submission**, not mid-run.
7. **Deletion is destructive and workspace-wide** — removes the test, its run history *and* its learned selectors, "for everyone in the workspace".
8. **Editing preserves history** — "RUN HISTORY AND LEARNED SELECTORS ARE KEPT" (`PATCH`, not replace).
9. **Exploration is read-only by consent** — never submits forms, obeys robots.txt, stays on-domain, never presses destructive buttons; creating data requires an explicit opt-in toggle.
10. **API keys are hashed, shown once, and scoped**; execute scope required to trigger runs, else `403`.
11. **Workspace isolation** — members only ever see their own workspace's data.

---

## 12. Bugs, inconsistencies and risks found

| # | Severity | Finding |
|---|---|---|
| 1 | **High** | **Inline "New suite" silently discards the name on blur.** Typing a suite name and clicking away issues no `POST /suites`; `Save` then writes the test into the *first suite in the list* with no warning. Only `Enter` commits. Causes wrong-suite writes. (§5.2) |
| 2 | **Medium** | **Login copy is false:** *"Runs are disabled on the demo account, so nothing you click there spends tokens."* `Run now` on the demo account returns `202 queued` and the run really executes. (§3) |
| 3 | **Medium** | **No validation in the composer.** `Save` is enabled with an empty name and no real steps, creating junk records (the workspace already contains many `New Test …`/`PENDING` rows, evidence this happens in practice). (§5.5) |
| 4 | **Low-Med** | **`Usage` sub-tab does not switch back** from `Appearance` — panel content stays on Appearance. (§10) |
| 5 | **Low** | **`File ▸ New Suite` does not create a suite** — it opens the test composer. Misleading label. (§2) |
| 6 | **Low** | **Test rows are not clickable** although they look like rows and are `tabindex=0`; Runs rows *are* clickable. Inconsistent affordance. (§4) |
| 7 | **Low** | `hit the Escape key` classifies as **CLICK/LOOKUP** while `press Enter`/`press Tab` classify as **KEY/PATTERN** — inconsistent, and turns a free step into a paid lookup. (§5.4) |
| 8 | **Low** | Unrecognised gibberish silently becomes a **CLICK/LOOKUP** step rather than being flagged, so typos become billable AI lookups at run time. (§5.4) |
| 9 | **Info** | `Add a step` is a `div`, not a button, and row action buttons have no accessible names (icon-only) — accessibility gaps in Kaizen's own UI, ironic given its analysis reports flag exactly this. |

---

## 13. Notes for whoever automates this app

- **Never assert on `page.url()`** for in-app navigation — it is always `/tests`. Assert on `<main>`'s heading text.
- Rows are `div.row` / `div.row-t`; there are **no `<table>` elements** in the lists.
- Row action buttons are **icon-only** — locate them by `title` (`Run now (⌘R)`) or by index inside `.row-actions`; hover the row first.
- `Add a step` is a `div.row`, so use `locator('div.row', {hasText:'Add a step'})`.
- The Analyze sheet renders **outside `<main>`** at `z-index: 60`.
- In the composer, `<main>` inputs: `0` = name, `1` = URL, `2…` = steps.
- The workspace is **shared and mutable** — counts drift while you work (another agent's records appeared mid-session). Assert on *relative* changes (before/after deltas) and on records you created, never on absolute totals.
- Runs and analyses are **long-lived background jobs**; triggering them from a test suite leaves work running after the suite exits.
