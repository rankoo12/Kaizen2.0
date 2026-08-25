# Kaizen web app — white-box knowledge

**Author:** AGENT-B (white-box QA)
**Sources:** `packages/web/src/**` (frontend source, read in full) + live exploration of `http://localhost:3001` with headless Playwright.
**Date:** 2026-08-21

Every claim below is tagged:

- **[CODE]** — read from source, not (yet) confirmed live.
- **[LIVE]** — observed against the running app.
- **[CODE+LIVE]** — read from source *and* confirmed live.
- **[DISAGREE]** — the code and the live app tell different stories. Collected again in §14.

---

## 1. What the product is

Kaizen is an AI-powered UI test-automation SaaS. Tests are written as **plain-English steps**; at run time an engine resolves each step to a real element, caching what it learns so repeat runs cost zero tokens. The web app is the console: author tests, run them, watch runs step-by-step, inspect the learned selector memory ("The Brain"), and let Kaizen explore an app and *write* tests for you ("Analyses" / the Test Writer).

## 2. Tech stack and shape **[CODE]**

- **Next.js App Router** (`packages/web`), React 19 style client components, TypeScript.
- No component library. Styling is **plain CSS classes** defined in `globals.css` / `aperture.css` (`.card`, `.btn`, `.field`, `.row`, `.list`, `.seg`, `.sheet`, `.scrim`, `.toast`, `.popover`, `.menu-item`, `.side-item`, `.mb-item`, `.toolbar`, `.badge`, `.pill`, `.switch`, `.spinner`, `.meter`, `.label`, `.num`, `.mono-chip`) plus heavy inline `style` objects.
- **There are no `data-testid` attributes anywhere in the app.** Verified by search across `packages/web/src`. Every selector must be role-, text-, placeholder-, title-, or CSS-class-based. This is the single most important fact for writing tests here.
- Backend calls go through a **catch-all proxy** at `/api/proxy/[...path]` (`route.ts`) which attaches the JWT from an http-only cookie, transparently refreshes on 401 and re-sets cookies. Auth endpoints are separate Next route handlers: `/api/auth/{login,demo,register,logout,me}`.

## 3. Routing, auth gating and a very important quirk

### Routes **[CODE+LIVE]**

| Path | Behaviour |
|---|---|
| `/` | `redirect('/login')` — server redirect, always. **[CODE+LIVE]** |
| `/login` | Renders `<AuthScreen mode="login">`. **[CODE+LIVE]** |
| `/signup` | Renders `<AuthScreen mode="signup">`. **[CODE+LIVE]** |
| `/tests`, `/tests/new`, `/tests/:id`, `/tests/:id/runs/:runId/report` | All render **the same thing**. See the quirk below. **[CODE+LIVE]** |

### Middleware **[CODE+LIVE]**

`src/middleware.ts`:

- `PROTECTED_PREFIXES = ['/tests']` — unauthenticated hits redirect to `/login?next=<pathname>`.
  Live: `GET /tests` while signed out → `http://localhost:3001/login?next=%2Ftests`. **[LIVE]**
- `AUTH_ONLY_PREFIXES = ['/login', '/signup']` — an authenticated visitor is bounced to `/tests` with `next` stripped. **[CODE+LIVE]**
- Gating is purely "does the `ACCESS_COOKIE` cookie exist" — it does **not** validate the token. A forged/expired cookie passes middleware and fails at the proxy instead.
- `matcher` excludes `_next/static`, `_next/image`, `favicon.ico` and `api/`.

### The quirk: `(app)/layout.tsx` swallows `children` **[CODE+LIVE]**

```tsx
export default function AppShellLayout() {
  return <KaizenApp />;   // note: no {children}
}
```

The route-group layout renders `<KaizenApp />` and **never renders `{children}`**. Consequences you must design tests around:

- Every URL that **matches a real `page.tsx`** under `/tests` renders the identical single-page app, always starting on the **Tests** screen. **[LIVE]**

  Routing itself is still real — only paths with a matching page resolve. Measured live:

  | Path | Result |
  |---|---|
  | `/tests` | app (Tests screen) |
  | `/tests/new` | app (Tests screen) — *not* the author screen |
  | `/tests/abc` | app (Tests screen) |
  | `/tests/abc/runs` | **404** — no `runs/page.tsx` |
  | `/tests/abc/runs/def` | **404** — no `[runId]/page.tsx` |
  | `/tests/abc/runs/def/report` | app (Tests screen) |
  | `/tests/a/b/c/d/e` | **404** |

  So "any URL under /tests renders the app" is false; the correct statement is that the four *defined* routes all render the same thing, and anything else 404s.
- `page.tsx` files under `(app)/tests/**` (`TestsDashboard`, `NewTestScreen`, `TestDetailScreen`, `RunReport`) are **dead code** — never rendered. Do not write tests against them.
- **Navigation inside the app never changes the URL.** Screens switch via React state (`const [screen, setScreen]`). The address bar stays on whatever `/tests…` URL you landed with. So: *no deep-linking, no browser Back within the app, and a page reload always resets you to the Tests screen.* Tests must navigate by clicking, not by `page.goto`.

### Cookie session **[CODE]**

`ACCESS_COOKIE` / `REFRESH_COOKIE` (`src/lib/cookies.ts`), http-only. `AuthProvider` hydrates from `GET /api/auth/me` on mount; while that is in flight the sidebar shows the initial `·` and the name **"Signing in…"** rather than a fake user.

## 4. Sign-in screen (`/login`) **[CODE+LIVE]**

Rendered by `components/design/screen-auth.tsx` — **not** `organisms/login-form.tsx`, which is stale unused code with different copy ("Welcome Back!", "Forgot Password?", social auth). Ignore it.

Observed live DOM:

- `h1` = **"Sign in to Kaizen"**; subtitle **"Your tests have been running while you were away."**
- Two `.label` captions: **Email**, **Password**.
- `input[type=email]`, `placeholder="you@company.com"`, `autocomplete="email"`, `autoFocus`.
- `input[type=password]`, `placeholder="••••••••"`, `autocomplete="current-password"`.
- Buttons in order: **"Sign in"** (`type=submit`, `.btn.pri.lg`), **"Demo user"** (`type=button`, `.btn.lg`), **"Create a workspace"** (an unstyled `<button>` that `router.push('/signup')`).
- The "or" divider sits between Sign in and Demo user.
- Demo caption: *"Look around a real workspace without signing up. Runs are disabled on the demo account, so nothing you click there spends tokens."* **[DISAGREE — see §14]**
- Footer: *"Sessions are cookie-based, so you stay signed in on this device."*

### Login behaviour

- Busy state swaps the label to **"Signing in…"** and disables both buttons; a `.spinner` renders inside. **[CODE]**
- Failure renders `<div role="alert">` inside the form with `.fail` colouring and an X icon.
  - `401` → **"Invalid email or password"** (mapped in `auth-context.tsx`, not from the server body). **[CODE+LIVE]** — confirmed live with `nobody-agentb@example.com` / `wrongpassword123`.
  - Other statuses fall back to the server `message`, else *"Something went wrong. Please try again."*
- **No client-side validation on the login form at all** — empty email/password submits and gets the server's 401. `type=email` gives native browser validation, so a genuinely malformed value blocks submit at the browser level.
- On success: `router.push(searchParams.get('next') ?? '/tests')`.

### Demo login **[CODE+LIVE]**

- `POST /api/auth/demo` with **no body**. Credentials live server-side (`KAIZEN_DEMO_EMAIL` default `test@test.com`, `KAIZEN_DEMO_PASSWORD` default `test1234`), so they are never in the browser bundle.
- Busy label: **"Opening the demo…"**.
- Error mapping: `404` → *"Demo access is turned off on this deployment"*; `401` → *"The demo account is unavailable right now"*.
- Live: signs in as **test@test.com / "Demo user"**, tenant `d2bf87a1-…`, **role `owner`**. **[LIVE]**
- **Do not test-drive `Demo user` expecting a read-only account.** It is the workspace owner and can create, edit, delete, create API keys, and start runs.

## 5. Sign-up screen (`/signup`) **[CODE+LIVE]**

Same `AuthScreen` component, `mode="signup"`.

- `h1` = **"Create your workspace"**; subtitle **"Tests written in English that keep passing on their own."**
- Four fields, in order: **Your name**, **Email**, **Password** (`autocomplete=new-password`), **Confirm password**.
- ⚠ **Selector trap, measured live:** the name input has **no `type` attribute at all** (`getAttribute('type') === null`). The DOM *property* `input.type` defaults to `"text"`, so it looks like a text field in devtools — but the CSS attribute selector **`input[type="text"]` matches nothing**. Target it by `placeholder="Ada Lovelace"` or `autocomplete="name"` instead. This cost real test failures before it was found.
- The Password label carries a hint span: **"· 8 characters or more"**.
- Submit button: **"Create workspace"** (busy: **"Creating…"**).
- Link at the bottom: **"I already have an account"** → `/signup`→`/login`.
- **The Demo user button and its caption do not render in signup mode** (`{!signup && …}`). **[CODE+LIVE]**

### Client-side validation, in this exact order **[CODE+LIVE — all three confirmed live]**

1. `!name.trim()` → **"What should we call you?"**
2. `pw.length < 8` → **"Use at least 8 characters for the password."**
3. `pw !== confirm` → **"Those passwords don't match."** (note the **typographic apostrophe** `’`, not `'`)

Validation runs **before** `setBusy(true)`, so a rejected submit never shows a spinner and never calls the API. Because the checks are ordered, an empty form always reports the *name* error first even though the password is also invalid.

Email and password are `.trim()`-ed on submit; the name is trimmed too.

### Server errors from register **[CODE]**

`409` → **"An account with this email already exists"**; `400` → **"Please check your details and try again"**.

### Alert element gotcha **[LIVE]**

Next.js injects `<div role="alert" aria-live="assertive" id="__next-route-announcer__">` into the document. A bare `page.locator('[role=alert]')` is a **strict-mode violation**. Always scope: `form [role="alert"]`.

## 6. The authenticated shell **[CODE+LIVE]**

`components/design/kaizen-app.tsx` is the whole authenticated app: a fake-macOS window with a menu bar, a sidebar and a body that swaps between screens.

### Menu bar (`.menubar`) **[CODE+LIVE]**

A non-interactive brand item **"Kaizen"**, then four menus. Clicking a `.mb-item` toggles a `.popover`; hovering another while one is open switches to it; a `mousedown` outside closes. The right-hand status shows the signed-in email.

| Menu | Items (live) |
|---|---|
| **File** | `New Test ⌘N`, `New Suite`, *(separator)*, `Analyze an app…` |
| **View** | `Tests ⌘1`, `Runs ⌘2`, `Analyses ⌘3`, `The Brain ⌘4`, `Usage ⌘5`, *(sep)*, `Next appearance ⇧⌘A`, `Hide sidebar ⌥⌘S` / `Show sidebar` |
| **Account** | the user's email (**disabled**, `opacity:.4`), `Usage & settings`, *(sep)*, `Sign out` |
| **Help** | `Keyboard: ⌘N new · ⌘R run · ⌘1–4 screens` (**disabled**) |

Note: **"New Suite"** in the File menu just calls `go('author')` — it opens the New-test screen, not a suite dialog. **[CODE]**

### Sidebar (`.sidebar`) **[CODE+LIVE]**

Traffic lights (`.lights` — Close/Minimise/Fill the screen, all no-ops: `onLights={() => {}}`), a hide-sidebar toggle, the Kaizen logo, then:

- `Workspace` section label.
- Nav items from `NAV` in `data.ts`: **Tests**, **Runs**, **Analyses**, **The Brain**, **Usage** — each a `.side-item` with `aria-current` set when active. Only **Tests** carries a count badge (`counts.tests = cases.length`).
- Beside **Tests**: a `+` button `title="New suite"` and a chevron `title="Hide suites"/"Show suites"`.
- Suite rows nested under Tests (`paddingLeft: 26`), each with its own case count and a `.live-dot` when an analysis is running on it.
- A "QA engineer" activity card appears only while jobs are in flight.
- **Settings** `.side-item` (goes to the Usage screen).
- The user pill at the bottom: initials square + display name. Disabled until the session resolves.

### Screen switching and `activeNav` **[CODE]**

`go(screen, arg)`:
- `go('tests', suiteId)` sets the suite filter and calls `refetch()`.
- Any screen other than `author`/`run` **clears** the suite filter — deliberate, so the sidebar highlight doesn't stay stuck on a suite while you're on Runs.
- `activeNav = suite || (author|run → 'tests') || (usage → 'usage') || screen`.

### Keyboard shortcuts **[CODE+LIVE — all confirmed]**

Registered on `window` in `kaizen-app.tsx`; they require Meta **or** Ctrl (so Ctrl works on Windows/Linux):

| Keys | Effect |
|---|---|
| `Ctrl/⌘ + N` | New test (clears `editing`, opens the author screen) |
| `Ctrl/⌘ + 1..5` | Tests / Runs / Analyses / The Brain / Usage |
| `Ctrl/⌘ + Alt + S` | Toggle sidebar |
| `Ctrl/⌘ + Shift + A` | Cycle appearance: `aperture → light → dark → aperture` |

And in `screen-tests.tsx` only:

| Keys | Effect |
|---|---|
| `↑` / `↓` | Move selection through the filtered list, focusing the row |
| `Ctrl/⌘ + R` | Run the **selected** row (no-op when nothing is selected) |
| `Enter` (row focused) | Open the row's latest run |

The Tests-screen handler **bails out when the event target is an `INPUT` or `TEXTAREA`** — so arrows and ⌘R do nothing while the search box has focus. **[CODE]**

Note the global handler's `useEffect` has an **empty dependency array** while closing over `nextAppearance` — harmless because `nextAppearance` is a stable `useCallback`, but the ⌘R handler in `screen-tests` *does* re-subscribe on `[list, selId, onRun]`.

### Appearance **[CODE+LIVE]**

- Written to `document.documentElement[data-appearance]` and persisted in `localStorage['kaizen.appearance']`.
- Default and first cycle entry is **`aperture`** — *not* the system preference. `prefers-color-scheme` is deliberately ignored.
- Live: initial `aperture`; ⇧⌘A → `light` → `dark` → `aperture`; choosing **Dark** on the Usage → Appearance tab sets `dark`, and it **survives a page reload**.
- Grouping preference persists in `localStorage['kaizen.groupBySuite']` as `'1'`/`'0'`.

### Toasts (`.toast`) **[CODE+LIVE]**

- One at a time. `showToast(message, kind, onClick)` renders `<div class="toast">` — or a `<button class="toast">` when an `onClick` is supplied (so a "your plan is ready" toast is also the way to it).
- **Auto-dismiss after exactly 2600 ms**, cancelled only if a newer toast replaced it. Live timing: present at 300 ms and at 1.8 s, **gone by 3.3 s**. Any test asserting toast text must do so within ~2 s of the action.
- Tones: `success` → pass green, `error` → fail red, `heal`, `info` → accent. The `.toast` text is **rendered uppercase by CSS** — `innerText` comes back as e.g. `GIVE THE TEST A NAME` while the source string is sentence case. Assert case-insensitively.

### Sheets / modals **[CODE+LIVE]**

`Sheet` renders `.scrim > .sheet`. Closing paths, all live-confirmed:
- **Escape** (a `keydown` listener on `document`).
- **mousedown on the scrim itself** (`e.target === e.currentTarget`), i.e. clicking outside the card.
- The sheet's own Cancel/dismiss button.

`ConfirmSheet` adds a dismiss button (default label `Cancel`, overridable) and a red confirm button; `onConfirm()` runs *then* `onClose()`.

## 7. Tests screen (`screen-tests.tsx`) — the default screen **[CODE+LIVE]**

### Toolbar

- Title `Tests`, subtitle `"{n} tests across {m} suites"` — live: `22 tests across 3 suites`. The subtitle counts **all** cases and **all** suites, ignoring the current filter.
- When a suite filter is on: title becomes the suite name, subtitle its description, and a **Back** button (`button[title="Back"]`) appears which clears the filter.
- Search box: `input.field[placeholder="Search tests"]`, wrapped in `.hide-narrow` (hidden at narrow widths).
- A `.seg` filter group: **All / Failing / Healed / Passed**, plus **`Drafts {n}`** which only renders when `draftCount > 0`. Buttons carry `aria-pressed`.
- **Run suite** button — only when a suite filter is active.
- **Analyze** button (`I.sparkle` + "Analyze").
- **New Test** (`.btn.pri`).

### Filter semantics **[CODE+LIVE]**

Filters read `c.status` (the **last run's** status), except Drafts which reads `c.caseStatus` (the **case lifecycle**):

| Filter | Predicate |
|---|---|
| All | everything |
| Failing | `status === 'failed' \|\| status === 'cancelled'` — **cancelled runs count as failing** |
| Healed | `status === 'healed'` |
| Passed | `status === 'passed'` |
| Drafts | `caseStatus === 'draft' \|\| caseStatus === 'validating'` |

Live counts at exploration time: All 22, Failing 9, Healed 0, Passed 5, Drafts 1. Note **9 + 0 + 5 ≠ 22** — cases that have never run have `status = 'pending'` and match no filter but All.

Search matches, case-insensitively, against the concatenation `"{name} {suiteName} {baseUrl} {author}"` — so searching a suite name or a hostname finds tests. **[CODE]**

The suite filter and the search/segment filters **compose** (all applied in the same `.filter`).

### Suite-health card **[CODE+LIVE]**

- A `Ring` showing `green = round((pass + healed) / total * 100)` with the label `{green}%` and sub `Green`. When `total === 0` the ring is `0%` (guarded).
- Copy: `"{pass} passed clean, {healed} healed themselves, {fail} need a human."`
- Three stats: **Needs a human** (a `<button>` — clicking it sets the filter to `failing`; gets the `hazard` class when `fail > 0`), **Self-healed**, **From memory** (`{fromMemory}%` when any case has run, else `—` with sub `no runs yet`).
- `fromMemory = round(cases-with-lastCost-0 / cases-that-have-run * 100)`.
- **These stats are always workspace-wide.** They are computed in `useDesignData` over *all* cases and are not re-derived for the active suite filter — so opening a brand-new empty suite still shows the whole workspace's numbers. Live-confirmed on a freshly created `AGENT-B Suite`, which showed "5 passed clean … 9 need a human" with zero tests in it. **[CODE+LIVE]**
- All the numbers animate via `CountUp` (~780 ms, ~1000 ms for the ring). Assertions on these must poll/retry rather than read once.

### The list

Column header (`.list-h`): `TEST · MEMORY · COST · TOK · STATUS · LAST RUN` (+ an empty actions column). Rendered **only when `list.length > 0`**.

Grouping: when `group` is on **and no suite filter is active**, rows are grouped under suite headers (icon + name + count + description); groups with zero matching items are dropped. With a suite filter, or grouping off, it's one flat list.

Each row (`.row.focus-row`, `tabIndex=0`):

- A sparkle icon (`aria-label="Written by Kaizen"`) when `origin === 'generated'` — it persists after acceptance, so provenance never fades.
- The test name; a `DRAFT` badge when `caseStatus === 'draft'`; a `PROVING` badge when `caseStatus === 'validating'`.
- Sub-line: the base URL with `https?://` stripped, then `·` and the author (the display name, or the local part of the email). Author is **omitted entirely** when unknown — never "Unknown".
- MEMORY column: `cacheHitPct`, or **`—`** when null (never `0%`). Tooltip explains which.
- COST column: `—` when never run, **`free`** when 0 tokens, else `fmt.k()` (`1.2k`, `1.5M`).
- STATUS badge; LAST RUN relative time (`just now` / `Nm ago` / `Nh ago` / `yesterday` / `Nd ago` / a locale date), or **`never`**.
- Row actions (`.row-actions`, revealed on hover):
  - **Draft** rows: a `Proof` button (only when `validationRunId` exists) and an **Accept** button — *no play button*, because the backend refuses to run a draft.
  - Non-draft rows: a play icon `title="Run now (⌘R)"`, **disabled while `caseStatus === 'validating'`**.
  - Always: a `⋯` more button opening a `Menu`.

Row `⋯` menu contents **[CODE+LIVE]**:
- Draft: `Accept into the suite`, `Edit steps`, *(sep)*, `Delete test`.
- Non-draft: `Open latest run ⏎`, `Run now ⌘R`, `Edit steps`, *(sep)*, `Delete test` (red).

Interactions: single click **selects** (adds `.sel`, does not navigate); **double click opens** the latest run; `Enter` on a focused row opens it. All three confirmed live.

The `⋯` menu is rendered through `createPortal` into `document.body` at a fixed position, and **closes on any scroll or resize** — so a test must not scroll between opening the menu and clicking an item.

### Empty states **[CODE+LIVE]**

Two distinct ones:

1. **Never-used workspace** (`!list.length && !cases.length && onAnalyze`): a sparkle card headed **"Your suite is empty. Kaizen isn't."**, with buttons `Analyze my app` and `Write a test yourself`, and the footnote *"Takes a few minutes · read-only exploration · you approve the plan before anything is executed"*.
2. **Filtered to nothing** (any other empty case): heading **"No tests match"** when `cases.length > 0`, or **"No tests yet"** when it's genuinely 0; body *"Try a different filter, or write a new test in plain English."* / *"Write your first test in plain English."*; a `New Test` button. Live-confirmed for a nonsense search and for the Healed filter.

### Footer hint strip

`↑↓ move · ⏎ open latest run · ⌘R run · ⌘N new test`. Always rendered.

### Run suite **[CODE+LIVE]**

Only visible with a suite filter. `runnableCount` = cases in that suite with `caseStatus === 'active'` — **drafts are excluded**. When `runnableCount === 0` the button is **disabled** with `title="Nothing to run yet — accept a draft or write a test first"`; otherwise `title="Run all {n} accepted test(s) in this suite"`. Live-confirmed on an empty new suite.

On success the toast reads `Queued {n} test(s)` plus ` — skipped {d} draft(s)` when drafts were skipped. The screen **stays on the list** (no jump to a run) because many runs are in flight at once.

### Delete confirmation **[CODE+LIVE]**

`ConfirmSheet` titled **`Delete "{name}"?`** (typographic quotes `“ ”`), message: *"The test, its run history and its learned selectors are removed for everyone in the workspace. This can't be undone."*, buttons **Cancel** and **Delete test**. On confirm: `DELETE /api/proxy/cases/:id` → toast `Deleted "{name}"` with kind `error` (red — a deliberate choice) → `refetch()`.

### Pending-delivery banner **[CODE+LIVE]**

When a Test Writer job needs attention, a full-width clickable `.card.rise` sits above everything with status-dependent copy:

| Job status | Copy | Button |
|---|---|---|
| `awaiting_plan_approval` | "A test plan is ready for your approval." | `Review the plan` |
| `queued` | "Kaizen is starting up an analysis." | `View progress` |
| `running` | "Kaizen is exploring your app — N pages so far." | `View progress` |
| done, `count > 0` | "N proven test(s) are waiting for review." | `Review delivery` |
| done, `count === 0` | "Your last analysis proposed nothing — the reasons are in its report." | `See why` |

The demo workspace was live in the last state.

### Polling **[CODE]**

While the Tests screen is showing **and** any case is `queued`/`running`, `refetch()` fires every **4 s**. It stops when nothing is in flight, so an idle workspace makes no requests. `go('tests')` also forces a `refetch()`.

## 8. Author screen — new / edit test (`screen-author.tsx`) **[CODE+LIVE]**

Reached by: `New Test` button, `⌘N`, File → New Test, File → New Suite, or a row's `Edit steps`.

### Toolbar

- Title: **"New test"** with sub *"Write it in English — Kaizen finds the elements at run time"*; in edit mode the title is the test's name and the sub is *"Editing the steps. Run history and learned selectors are kept."*
- Buttons: **Suggest tests**, **Cancel**, **Save**, **Save & Run** (`.btn.pri`).

### Form

- **Test name** — `input.field`, `placeholder="Sign in with valid credentials"`, `autoFocus`.
- **Suite** — a `<select class="field">` of real suites, defaulting to `defaultSuiteId || suites[0]?.id`. Beside it a `+` button `title="New suite"` swaps the control for an inline `input[placeholder="New suite name"]` plus a ✓ `title="Create suite"` (disabled while empty) and an ✗ `title="Cancel"`. `Enter` creates, `Escape` cancels. When there are no suites the select shows a single `No suites yet` option with `value=""`.
- **Target URL** — `input.field.num`, initial value literally **`https://`**.

### "Start from" templates **[CODE+LIVE]**

Three buttons that **replace** the entire step list, built from whatever is currently in the URL field (`starters(url)`; an empty URL falls back to `https://`):

- **Sign-in flow** (6 steps): `navigate to {u}`, `dismiss the cookie banner if it appears`, `type your email in the email field`, `type your password in the password field`, `click the "Sign in" button`, `verify the page contains "Dashboard"`.
- **Search a site** (4 steps): `navigate to {u}`, `type "hello" in the search box`, `press Enter`, `verify the results list is not empty`.
- **Blank** (1 step): `navigate to {u}`.

All three verified live, character for character.

### Step editor **[CODE+LIVE]**

`.list` with a header `STEPS · PLAIN ENGLISH, IN ORDER` and a live count on the right. Each row has: a drag handle icon (**decorative — drag-and-drop is not implemented**), a 1-based index, a **verb chip** (`.mono-chip`), the text `input.field` (`placeholder="e.g. click the “Sign in” button"`), and three icon buttons `Move up` / `Move down` / `Remove`.

- `Move up` is disabled on row 1; `Move down` is disabled on the last row. **[LIVE]**
- Pressing **Enter** inside a step input inserts a **new empty step below** and focuses it. **[LIVE]**
- A final `.row` reading **"Add a step"** appends an empty step.
- Removing is immediate — no confirmation.

### Verb parsing (`parseStep`) **[CODE+LIVE — full table verified live]**

Matching is: lowercase, trim, first try `startsWith` over the `VERBS` table in order, then `includes(' {verb} ')`. **Unmatched text defaults to `Click`.**

| Step text | Verb chip | Lookup? |
|---|---|---|
| `navigate to https://example.com` | NAVIGATE | no |
| `click the Sign in button` | CLICK | yes |
| `type hello in the box` | TYPE | yes |
| `verify the page contains "X"` | ASSERT | yes |
| `press Enter` | KEY | no |
| `wait 2 seconds` | WAIT | no |
| `select an option` | SELECT | yes |
| `check the box` | CHECK | yes |
| `drag it` | DRAG | yes |
| `scroll down` | SCROLL | no |
| `remember the order id` | CAPTURE | yes |
| `switch to the new tab` | TABS | yes |
| `dismiss the banner` | CLICK | yes |
| `blah blah unknown` | **CLICK** (default) | yes |
| `reload` | NAVIGATE | no |
| `go back` | NAVIGATE | no |
| `open https://x.com` | NAVIGATE | no |
| *(empty)* | `—` | no |

**Lookup** is `!NO_LOOKUP.test(t)` where `NO_LOOKUP = /^(navigate|go to|open |reload|wait|scroll|press|go back)/`. Note the **trailing space after `open`** — so `open` alone still counts as a lookup, but `open https://…` does not. And `dismiss`/`switch to` map to a verb but are *not* in `NO_LOOKUP`, so they cost a lookup.

Live check of the 17-step probe: **7 "need no lookup", 10 "find an element"** — matches the table exactly.

### Compile-preview inspector (`.inspector`, right rail) **[CODE+LIVE]**

- Heading **"What Kaizen will do"** with sub *"Read straight from your steps. Only the element lookups can ever cost tokens."*
- Two tiles: `{filled - lookups}` **need no lookup** (cache colour) and `{lookups}` **find an element** (warn colour). `filled` counts only steps with non-blank text.
- A note explaining a known page costs `0`.
- **Compiled plan**: one card per non-blank step with a zero-padded index (`01`, `02`…), the verb chip, and either a `LOOKUP` badge or a `PATTERN · 0 TOK` `SourceTag`. When nothing is filled: *"Write a step and it shows up here."*

### Validation (`validate()`) — all client-side, all reported as **toasts** **[CODE+LIVE]**

In this order, first failure wins and returns:

1. `!name.trim()` → toast `Give the test a name` (kind `error`)
2. `!/^https?:\/\/.+/.test(url.trim())` → toast `Target URL needs to start with http:// or https://`
3. `!suiteId` → toast `Pick a suite, or create one`
4. no non-blank steps → toast `Write at least one step`

All four confirmed live (1, 2 and 4 directly). Note validation runs on **both** Save and Save & Run.

Because the default URL is `https://` — which **passes** the regex (`.+` matches nothing? no: `https://` has nothing after `//`, so it *fails*)… in practice `https://` alone fails rule 2, so a brand-new test cannot be saved without editing the URL. **[CODE]**

### Button enable/disable rules **[CODE+LIVE]**

- **Save** — disabled only while `busy` (i.e. mid-request).
- **Save & Run** — disabled while `busy` **or when `filled.length === 0`** (no non-blank steps).
- **Suggest tests** — disabled unless `suiteId` is set **and** `/^https?:\/\/.+\..+/i` matches the URL (note the extra `\..+` — it demands a **dot in the host**). So `https://` → disabled with `title="Enter the page URL first"`; `https://example.com` → enabled with `title="Ask Kaizen what this page is missing"`. Live-confirmed: disabled on arrival, enabled after typing a real URL.

### Save behaviour **[CODE+LIVE]**

- Create: `POST /api/proxy/suites/{suiteId}/cases` with `{name, baseUrl, steps}` (steps trimmed and blanks dropped).
- Edit: `PATCH /api/proxy/cases/{id}` with the same body — **the identity, run history and learned selectors are preserved** (versioning protocol).
- On `Save` (not run): toast **`Test saved`** / **`Changes saved`**, then `onCreated(caseId, null)`.
- On `Save & Run`: also `POST /api/proxy/cases/{id}/run`; toast **`Saved — booting a browser`**. If the run POST fails the test is still saved and the toast says **`Test saved, but the run could not start`**.
- **After either, the app navigates to the Run screen for that case** — live-confirmed: saving a brand-new test landed on the run screen showing *"This test has never run / Run it once and every step, selector and screenshot shows up here."* with a `Run it now` button.

### Edit mode load **[CODE+LIVE]**

`GET /api/proxy/cases/{id}` with `cache: 'no-store'`; tolerates both `{case: …}` and a bare object, and both camelCase and snake_case (`baseUrl`/`base_url`, `suiteId`/`suite_id`, `rawText`/`raw_text`). Blank step texts are filtered out; if **every** step is blank the existing default is kept. A failed load toasts `Could not load the test`.

Live round trip verified: created a test with 2 steps → edited to add `wait 1 second` → reopened and saw all **3** steps in order.

### Cancel **[CODE+LIVE]**

`Cancel` and the toolbar Back both call `onBack` → `returnToAnalyze()`, which returns to the Tests screen (or re-opens a parked Analyze sheet if one was left mid-flow). Confirmed live.

## 9. Run screen (`screen-run.tsx`) **[CODE+LIVE]**

Reached by double-clicking a row, Enter on a row, opening a Runs-feed row, saving a test, running a test, or the Brain's "Open the step that used it".

### Toolbar

- Back button, the case name as the title, sub `#{runId.slice(0,8)} · {host} · {triggeredBy}` — live: `#1E2842F5 · THE-INTERNET.HEROKUAPP.COM · WEB` (uppercased by CSS).
- A `.seg` of tabs: **Steps / Line / Activity / History**.
- **Re-run** button.
- A `⋯` menu: `Edit steps`, `Refresh now`, `Copy run id`, and **`Cancel run` only when the run is non-terminal** — live-confirmed: absent on a finished run, present on a running one.

### The "never run" state **[CODE+LIVE]**

When there is no run id at all: a card **"This test has never run"** / *"Run it once and every step, selector and screenshot shows up here."* with a `Run it now` button.

### Summary strip **[CODE+LIVE]**

- While running: a spinner, and either **"Queued — waiting for a browser"** or **"Running step {n} of {total}"**, with sub **"Polling every 2s"**.
- When done: a status circle, the status label (`Passed` / `Failed` / …), with **`Passed, self-healed`** as a special label for `healed`; sub `{n} steps · {relative time}`.
- Stats: **Duration** (with `"{d} faster/slower than last"` when a previous terminal run exists), **Tokens spent** (`"was {n} last run"`), **From memory** `{cacheSteps}/{lookupSteps}` (`—` when no lookups), and a **Progress** meter `{landed}/{total} steps`.

Live sample: `Passed · 3 steps · 23h ago · Duration 3.68s (2.30s faster than last) · Tokens 0 (was 0 last run) · From memory 2/2 · 3/3 steps`.

### Healed banner **[CODE]**

On a `healed` terminal run (and not on the Line tab) a heal-tinted card appears: *"A step healed itself, so nobody has to fix this test"* with a **See the step** button that jumps to the healed step.

### Steps tab **[CODE+LIVE]**

`.list` headed `STEPS · IN ORDER, STOPS ON FIRST UNHEALED FAILURE` with `{landed}/{total}`.

Rows are built by zipping the run's `stepResults` with the case's `steps`: results render as landed; the remainder render as `pending` with `opacity .32` and a spinner. A landed row shows: the status icon, the zero-padded index, the verb pill, the step text, then a badge row — a **SourceBadge**, the duration, a `Self-healed` badge, a `{{name}} = value` capture badge, `Pinned`/`Blocked` verdict badges, and the failure class in red.

Under it, either the heal diff (`old selector` struck through → `new selector`) or the plain `selectorUsed`.

Only landed rows are clickable/focusable.

### Resolution tiers — the vocabulary **[CODE+LIVE]**

`resolution-source.ts` maps `step_results.resolution_source` to a tier; `screen-run.tsx` maps it again to the design's `SOURCES` palette:

| `resolutionSource` | Tier | Badge | Colour meaning |
|---|---|---|---|
| `archetype` | L0 · Archetype | `PATTERN` | memory (free) |
| `redis` | L1 · Redis cache | `CACHE` | memory (free) |
| `db_exact` | L2 · Postgres exact | `CACHE` | memory (free) |
| `pgvector_step` | L3 · Vector (tenant) | `SIMILAR` | reasoned (free) |
| `pgvector_element` | L4 · Vector (shared) | `GLOBAL` | reasoned (free) |
| `llm` | L5 · LLM | `AI` | **costs money** (warn colour) |
| `delta` | Δ · What changed | `CHANGED` | free |
| anything else | `··` · the raw string | — | falls back to a token-only badge |

Live example: a cached step rendered `CACHE · 0 TOK` with the tooltip/inspector text **"Recalled from memory (L1 · Redis cache) — no model call, no tokens."**

### Step inspector (right rail) **[CODE+LIVE]**

Appears on the Steps and Activity tabs when a step is selected (never on Line or History). By default the screen auto-selects the **first failed step**, else the first healed step, else the last one that ran.

- Verb pill + status badge + the step text.
- **Evidence**: the screenshot from `/api/proxy/media?key=…` in a `button.shot.zoomable` (`cursor: zoom-in`) with the caption *"What the page looked like when the step finished. Click to enlarge."*. Clicking portals a `.zoom-scrim` overlay, dismissed by clicking it or by **Escape**. When there is no screenshot: a dashed box reading *"No screenshot was captured for this step."*
- **"Was this the right element?"** — only when `selectorUsed` exists. Two buttons: **`Yes — pin it`** and **`No — block it`**, which `PATCH /api/proxy/runs/{runId}/steps/{stepResultId}/verdict`. Success toasts: *"Element pinned — always reused for this step"* (success) / *"Pattern blocked — the brain will not use it again"* (error tone). The chosen button then renders filled (green/red).
- **"What broke, how it recovered"** / **"What went wrong"** disclosure — only when healed, or a `failureClass`/healing events exist. Shows the strategy, attempt count, the `old → new` selector diff, and an Attempts/Strategies/Healing-time strip.
- **"How it was resolved"** (open by default) — the tier label + tokens badge, an explanation sentence per tier, the **Selector used** block, a **Found inside a frame** block when `frameUrl` is set (cookie banners), and a Duration/Tokens/Candidates strip. A **Match %** cell is appended *only* for the two vector tiers.
- **"Captured for later steps"** when `capturedName` is set.
- **"What the model was shown"** / **"What changed after the action"** listing up to 12 `domCandidates`, highlighting `llmPickedKaizenId` with a `picked` badge.

### Line tab **[CODE+LIVE]**

A "Production line" visual: *"The session moves down the belt. Machines that remember run for free; the one that has to think draws power."*, an `N FREE` / `N TOK DRAWN` header, one machine per step, and a legend: **From memory** / **Drawing power** / **Repaired itself** / **Broke down**. The inspector is deliberately hidden here.

### Activity tab **[CODE+LIVE]**

A flat event feed. Per step it emits, in order: a `Found the element for "{step}"` event with the `L# · Label` sub (only when a tier exists), a heal event when healed, and a `{Verb} {status}` event with `{duration} · {tokens|no tokens}`. Empty state: *"Nothing has happened yet."*

### History tab **[CODE+LIVE]**

- A **Cost per run** card (only when >1 costed run *and* max cost > 0) with a `Sparkline` and copy *"This test cost {first} tokens on the oldest run kept and {last} on the newest."*, plus a `{n}% CHEAPER` badge when it improved. Live: `109 → 0`, badge **`100% CHEAPER`**.
- A table of `recentRuns`: `#{id8}`, the trigger (`web` / `api` / `cli` / `schedule` / `testwriter`), status, duration, tokens (`free` when 0, `—` when null), relative time. The showing run is marked `· showing` and highlighted with `.sel`.
- Clicking a row swaps the displayed run in place (`setRunId`) — the URL does not change.
- Empty: *"No runs yet."*

### Cancel run **[CODE+LIVE]**

`ConfirmSheet` **"Cancel this run?"** / *"The run stops after the step it's on. Steps that already finished keep their results and screenshots; the rest never execute."* Buttons: **`Keep running`** (dismiss — deliberately not "Cancel", to avoid two Cancels side by side) and **`Cancel run`**.

`POST /api/proxy/runs/{id}/cancel` with **no body and no Content-Type**. Status handling: `202` → *"Cancelling — the run stops after the current step"*; `200` → *"That run was already cancelled"*; `409` → *"That run had already finished"*; anything else → *"Could not cancel that run"*.

### Live polling **[CODE]**

`useRunDetail` polls `GET /api/proxy/runs/{id}` every **2000 ms** while the status is non-terminal, with a single-flight guard, and **skips while `document.visibilityState === 'hidden'`**. It stops on `passed|failed|healed|cancelled`.

### The completion HUD **[CODE]**

`RunCompleteHUD` fires ~340 ms after a run this screen **watched** go terminal — never when opening a historical run, and never twice for the same run. It tallies steps, cached steps, tokens, duration and "learned" (LLM resolutions + successful heals).

## 10. Runs screen (`screen-runs.tsx`) **[CODE+LIVE]**

- Toolbar `Runs`, sub `"{total} run(s) in this workspace, newest first"` — live: `129 runs in this workspace, newest first`.
- An `{n} active` pill with a pulsing dot when anything is queued/running.
- `.seg`: **All / Active / Failed / Healed**. `Active` = `running || queued`; the others are exact status matches. **There is no "Passed" filter here** (unlike the Tests screen).
- A `button[title="Refresh"]` that re-reads immediately.
- Stat strip: `RUNS SHOWN` (with sub `of {total} total` or `all of them`), `PASSED CLEAN`, `SELF-HEALED`, `FAILED`, `TOKENS` — **all computed over the loaded page only** (`limit=50`), not the whole workspace, and labelled that way on purpose.
- Table columns: `TEST · STATUS · DURATION · TOKENS · TRIGGER · WHEN`.
- A row shows the case name (or **`Deleted test`** when `caseName` is null), `#{id8}`, and either the suite + host, or — while live — a spinner with `waiting for a browser` / `step {n} of {total}` plus a `.meter` progress bar.
- Tokens render as `free` (0), `—` (null), or a grouped number.
- Trigger badge is the value **uppercased**.
- Clicking a row opens the Run screen. Clicking a row whose `caseId` is null toasts **"That test has been deleted"** and goes nowhere. **[CODE]**
- Empty states: `Loading runs…` / `No runs match that filter` / `No runs yet` + *"Run a test and it shows up here the moment it's queued."*
- Page size is **50**; polling every **4 s** while anything is active, skipped when the tab is hidden.

## 11. Analyses screen (`screen-analyses.tsx`) **[CODE+LIVE]**

- Toolbar `Analyses`, sub *"Every time Kaizen explored an app and proposed tests"*, plus an `Analyze an app` primary button.
- It fans out `GET /api/proxy/suites/{id}/jobs` **once per suite** and merges the results, sorted newest-first. A suite whose request fails contributes an empty list rather than breaking the screen.
- Stat strip (only when there is ≥1 job): **Analyses** (count, sub `all time`), **Tests proposed** (summed `report.validate.proposed`), **Spent writing** (summed `report.tokenUsage.total`, `—` when nothing measured).
- Columns: `APP · SUITE · STATUS · COST · TOK · WHEN`. The APP cell is the **host** of `targetUrl`; the sub-line is `outcomeOf(job)`.
- Status labels are remapped: `completed → DONE`, `awaiting_plan_approval → NEEDS YOU`, `running → WORKING`, `queued → QUEUED`, `failed → FAILED`, `blocked → BLOCKED`.
- `outcomeOf` copy: `"{n} scenarios planned — waiting for your approval"`, `"exploring — {n} pages so far"` / `"starting up"`, the raw `job.error` (or `stopped`) on failure, `"{n} proposed · {m} rejected"`, `"nothing proposed · {m} rejected, with reasons"`, or `"nothing proposed"`.
- Empty: **"No analyses yet"** with an `Analyze an app` button.
- Polls every **4 s** while any job is running/queued.
- Live: one job, `FAILED`, sub-line *"cancelled by founder — analyze side-job too long for the bench loop"*, `Analyses 1 / Tests proposed 0 / Spent writing —`.

## 12. The Brain screen (`screen-brain.tsx`) **[CODE+LIVE]**

Read-only view over `GET /api/proxy/brain/selectors?limit=300`.

- Toolbar `The Brain`, sub *"Every element Kaizen has learned, and how much it stops you paying"*, a search box `placeholder="Search what it knows"`, and a `.seg`: **All / Workspace / Global / Needs review**.
- Header card: a `Ring` of `hit = round(ok/uses*100)` labelled `Reliable`, the sentence `"{hit}% of recalls worked first time"` (or **"Nothing learned yet"**), and `"{ok} of {uses} remembered resolutions held up. The rest triggered healing."`; then **Learned elements** (with sub `{n} from the global brain`), **Avg confidence** (over entries with `uses > 0`), **Recalls**.
- Live: `98% Reliable · 301 of 308 · 38 learned elements (27 global) · avg 0.90 · 308 recalls`.
- Columns: `WHAT IT MEANS · SELECTOR / SITE / SCOPE / CONFIDENCE / RECALLS / VERIFIED`.
- Each row shows the step text that named it (`intent`), or — when null — an italic **"ready, unused"** (global scope) / **"step since deleted"** (tenant scope). Then the selector, a pin icon when pinned, a **`NEEDS REVIEW`** badge, and the owning case name (+ `+N more`).
- **`needsReview(b) = !b.pinned && b.confidence < 0.75`.** It deliberately ignores `failCountWindow` (which never resets) and past failures generally.
- `Confidence` colouring: `≥ .90` pass green, `≥ .75` warn, below that fail red; a falsy value renders `—`.
- Scope badge: **`GLOBAL`** (accent, cloud icon) vs **`WORKSPACE`** (fill, db icon).
- Search filters over `"{intent} {selector} {domain}"`, case-insensitively.
- Clicking a row expands an inline panel: **Selector Kaizen learned**, Outcomes `{ok} good · {uses-ok} bad`, **Success rate** (`—` when unused, green above 95 %), **Last failure**, then **Where it came from** (the intent, the case + suite, **First learned** with a source chip and time, **Last used**, **Tests relying on it**) and an **"Open the step that used it"** button when `caseId` and `lastRunId` both exist. That button deep-links into the Run screen with the step preselected.
- Empty states: `Reading the brain…` / `Nothing matches` / **"The brain is empty"** with a paragraph about runs filling it.
- Footer note explaining the cheapest-first cascade.
- Live data confirms **the same intent can appear twice — once `WORKSPACE`, once `GLOBAL`** (e.g. `type "tomsmith" in the Username field` at 50 recalls each). Row-count assertions must allow for that.

## 13. Usage / Settings screen (`screen-usage.tsx`) **[CODE+LIVE]**

Toolbar `Usage`, sub `"Signed in as {email}"`, and a `.seg` of four tabs: **Usage / API keys / Members / Appearance**.

### Usage tab **[CODE+LIVE]**

- **Tokens this month**: the number, `of {budget}` when a budget exists, and *"spent on finding elements"*. `…` while loading, `—` on error.
- **QuotaMeter** — three distinct states:
  - `budget <= 0`: a warn box, *"This workspace has no token allowance, so new runs are rejected at submit. Ask the workspace owner to allocate tokens."* — deliberately **not** an empty meter, because 0 budget ≠ 0 % used.
  - under budget: a meter, `"{n} left this cycle"` and `resets {locale date}`. Tone goes warn at **≥ 80 %**.
  - at/over budget: `"Limit reached — new runs are rejected until it resets"`, fail tone.
- Three stats: **Runs this month**, **Free runs** (`{pct}%` with sub `{n} of the last {m} cost nothing`, `—` when nothing costed), **Members**.
- On a `usage` fetch failure: *"Usage totals need admin rights on this workspace, so they're hidden for your role."*
- A permanent note about the monthly budget rejecting runs at submit.
- **Tokens per run · last 30 days** chart from `GET /tenants/{id}/usage/history?days=30`, plotting **tokens *per run*** so a busy day doesn't tower over a quiet one. Days with no runs render as a faint 2 px rule (`no runs` in the tooltip), a free day keeps the cache colour. Four states: `Loading 30 days…` / *"Run a test and the cost curve starts here."* / an all-zero card (*"Every run in the last 30 days cost 0 tokens… There's no curve to plot until something needs the AI again."*) / the real chart with `{n} tok/run on MM-DD` at each end. A `{n}% SINCE MM-DD` badge appears when the trend improved, measured **only over days that had runs**.
- Live: `55,196 of 5,000,000 · 4,944,804 left this cycle · resets 1.9.2026 · Runs this month 137 · Free runs 100% (50 of the last 50 cost nothing) · Members 1`, and the all-zero chart card.

### API keys tab **[CODE+LIVE]**

- A card explaining per-pipeline keys and that only the hash is stored, with a **New key** primary button.
- Table: `KEY · SCOPE · LAST USED · CREATED` plus a revoke button per row. `lastUsedAt` renders **`never`** when null (called out as the useful signal). An expired key appends ` · expired` to the prefix line.
- `keys === null` → **"Loading keys…"**; `keys === []` → **"No API keys yet" / "Create one to trigger runs from CI."** The two states are kept distinct so the empty state never flashes.
- **New key sheet**: `What is it for?` (`input`, **`maxLength=120`**, `placeholder="GitHub Actions — main"`), then `What may it do?` with three selectable cards — **Read only** ("Read tests, runs and results. Cannot start anything."), **Execute** ("Everything above, plus trigger runs. What CI usually needs.") — the **default** — and **Admin** ("Full workspace control, including creating more keys. Owner only."). Footer buttons `Cancel` / `Create key`.
- `403` handling is specific: `error === 'OWNER_REQUIRED'` → *"Only the workspace owner can create an admin key"*, otherwise *"You need admin rights to create a key"*.
- On success a second sheet, **"Your new API key"**, shows the raw key **once** with *"Copy it now — it isn't stored in a readable form and won't be shown again."*, and `Copy` / `Done` buttons. `Copy` writes to the clipboard and toasts **"Key copied"**.
- Revoke opens a `ConfirmSheet` **`Revoke "{desc}"?`** / *"Anything still using this key stops working immediately. Other keys in this workspace are unaffected."* with **`Keep it`** / **`Revoke key`**. Success toast: `Revoked "{desc}" — it stops working now`. A `404` on delete is treated as success (idempotent).
- A CI snippet card showing `POST $KAIZEN_API/runs` with `Authorization: Bearer`, and a note that `POST /cases/:id/run` is deliberately **not** shown because an API key gets 401 there.
- Live on the demo tenant: **"No API keys yet"**.

### Members tab **[CODE+LIVE]**

`MEMBER · ROLE · JOINED`. Each row: an initials square, the display name with **` (you)`** appended for the current user, the email, a `.pill` with the role, and the accepted date or **`invited`**. Empty: *"No members to show."* Live: one row, `Demo user (you) / test@test.com / owner / 5.8.2026`.

### Appearance tab **[CODE+LIVE]**

Two `.list` blocks:
- `APPEARANCE`: **Theme** (`Aperture / Light / Dark` seg — *"Aperture is the industrial skin; light and dark are the system ones."*) and **Group tests by suite** (a `.switch` with `role="switch"` and `aria-checked`, sub *"Off shows one flat list."*).
- `SESSION`: the display name + email and a red **Sign out** button.

## 14. Analyze sheet (`writer-analyze-sheet.tsx`) **[CODE+LIVE]**

Opened by the Tests-screen **Analyze** button, the Analyses screen, or File → Analyze an app…. Two modes share the component: `analyze` (whole app) and `suggest` (one page, reached from the author screen's **Suggest tests**).

- Title **"Analyze an app"** / **"Suggest tests for this page"**; width 580.
- Intro: *"Kaizen explores it read-only, shows you a test plan, and writes only what you approve."*
- **Suite** — a select of real suites, with a **New** button that swaps to an inline `input[placeholder="New suite name"]` + `Create` (disabled while blank) + `Cancel`. `Enter` creates, `Escape` cancels. A suite created here is immediately selected, added to a local `extraSuites` list, and `onSuitesChanged()` tells the whole app about it. When the workspace has **no** suites, the sheet opens **already in create mode**.
- **App URL** / **Page URL** — `input[placeholder="https://staging.your-app.com"]`, `spellCheck=false`, prefilled from the first case's `baseUrl` (or the page being authored, in suggest mode).
- Below it a **host-dependent notice**, decided by `looksLikeProduction()` = the hostname does **not** match `/staging|stage|dev|test|preview|localhost|127\.|\.local/i`:
  - production-looking → *"This looks like a production URL. Exploration is read-only… A staging environment is the calmer choice."*
  - otherwise → *"Use a staging URL if you have one. Kaizen never mutates data without your say-so, but proving tests means really running them."*
- **Describe your app** — a `textarea`, **`maxLength=8000`**, `rows=4`, with the note *"Don't paste credentials — they're detected and removed."* **Analyze mode only** (a scoped suggestion already knows what to look at).
- **"What Kaizen may do on your site"** card — a `Switch` for **"Allow tests that create throwaway data"** whose sub-copy *changes with the switch*: off → *"Off: signup and cart tests are still written, but proposed unproven instead of executed."*; on → *"Kaizen may create unique per-run records — accounts like kaizen+8f31@…, cart items, form submissions — while proving tests on this suite. Recorded on every job for audit."* Below it a `Disclose` **"What exploration does — and never does"**.
- **"Signed-in exploration"** card — a second `Switch`, **disabled unless the role is `admin` or `owner`** (`title="Only a workspace admin can enable signed-in exploration"`), with role-dependent sub-copy. Turning it on fetches `GET /cases?status=active&origin={origin}` and renders **"Which test signs in?"** — either a `<select>` grouped by suite via `<optgroup>`, or an empty state distinguishing *"No sign-in test for {host} yet — your other tests run against a different site."* from *"No sign-in test yet."*, plus a **"Write a sign-in test"** button that parks the whole form and jumps to the author screen with a 3-step template. Choosing a candidate renders a paragraph naming it and the sign-in count (`1 + maxScenarios`). A second `Disclose` covers who can see what.
- **Advanced** (a `▸`/`▾` toggle): **Exploration depth** (`Quick 10 / Standard 30 / Deep 50`, analyze mode only — a scoped job's budget is one page by design), **Tests to plan** (`input[type=number]`, `min=1`, `max=30` in analyze / `max=5` in suggest, default 6 / 3, clamped in the `onChange`), **Pause for my approval after planning** (default **on** in analyze, **off** in suggest), **Prove each test with a real run** (default on).
- Footnote (analyze only): *"Standard depth usually takes 2–5 minutes and well under 50k tokens of your budget. Deep scans can take up to 20 minutes."*
- Footer: `Cancel` and **`Start exploring`** / **`Suggest tests`**.

> **Testing constraint.** Submitting this sheet starts a long-running background
> exploration job that outlives the test run. **No test in this suite ever clicks
> "Start exploring" or "Suggest tests" (the submit).** Everything below about the
> submit gate was verified by reading the button's `disabled` state and `title`
> only — the dialog is opened, inspected, and dismissed.

### Submit gate **[CODE+LIVE]**

`canSubmit = !!suiteId && /^https?:\/\/.+/i.test(url.trim()) && !authIncomplete && !busy`, where `authIncomplete = authScope && !loginCaseId`. So the primary button is disabled for an empty or non-http URL, and disabled with `title="Pick the test that signs in, or turn signed-in exploration off"` when the sign-in grant is half-set.

### Requests **[CODE]**

- analyze → `POST /api/proxy/suites/{id}/analyze` with `{targetUrl, initBrief?, allowSyntheticData, options: {maxPages, maxScenarios, includeNegative: true, safeMode: true, validate, planApproval: 'review'|'auto'}}`.
- suggest → first a `PATCH /suites/{id}` saving `allowSyntheticData`, then `POST /suites/{id}/suggest` with `{pageUrl, options: {maxScenarios, includeNegative: true, validate, planApproval}}`.
- The sign-in grant travels **per job**, never as a saved preference: `{scope: 'authenticated', loginCaseId, authConsent: true}`.
- Any `body.warnings[]` are surfaced as info toasts (secret scrubbing).
- A suggest job that comes back `mode: 'analyze'` toasts *"Kaizen hasn't explored this app yet — running a full analysis first"*.

### Error copy (`loginErrorCopy`) **[CODE]**

Eight specific messages keyed off the API's `error` code — `AUTH_CONSENT_REQUIRED`, `AUTH_SCOPE_REQUIRES_ADMIN`, `AUTH_SCOPE_NOT_VIA_IMPERSONATION`, `LOGIN_CASE_NOT_FOUND`, `LOGIN_CASE_NOT_ACTIVE`, `LOGIN_CASE_ORIGIN_MISMATCH`, `LOGIN_CASE_NAVIGATES_OFF_ORIGIN`, `LOGIN_CASE_USES_SEED_TOKENS`. Those eight render **beside the sign-in card**; everything else renders at the foot of the sheet. Unrecognised codes fall back to the server's `message`, else *"Could not start the analysis."*

On success `onStarted(suiteId, jobId)` closes the sheet, jumps to the **Writer** screen for that job, forces a suite re-read, rescans the job poller and toasts *"Exploring your app — this keeps running if you leave"* (or *"Looking at that page…"* for suggest).

## 15. Data mapping — how API shapes become screen shapes **[CODE]**

`use-design-data.ts` composes `useSuites` + `useAllCases` + `useAuth`:

- `status` = the **last run's** status, or `'pending'` when there is none.
- `lastCost` = `lastRun.totalTokens ?? 0`, but **`null` while the run is in flight** (`queued`/`running`) — deliberately not "0" for an unfinished run.
- `lastRun` (the label) = `'now'` while in flight, else a relative time, else `''`.
- `hasRun` = there is a run **and** it is not in flight.
- `author` = `displayName || email.split('@')[0]`, `''` when unknown.
- `cacheHitPct` / `firstRunTokens` = `null` when unmeasured (must not render as 0).
- `caseStatus` defaults to `'active'`, `origin` to `'user'` for older payloads.
- Suite icons are chosen by regex on the name: `auth|login|sign|identity|account → keys`, `checkout|cart|pay|order|billing → bolt`, `search|discover|filter → search`, `smoke|platform|health|baseline → globe`, `setting|profile|admin → settings`, else a cycling fallback.
- `initials()` splits on whitespace/`@`/`.` and takes the first letter of the first two parts, uppercased.

Relative-time thresholds (used identically in four files): `< 60s → "just now"`, `< 60m → "{m}m ago"`, `< 24h → "{h}h ago"`, `1d → "yesterday"`, `< 7d → "{d}d ago"`, else `toLocaleDateString()`.

Number formatting (`fmt` in `data.ts`): `n` → `toLocaleString('en-US')`; `k` → `1.2k` / `12k` / `1.5M`; `ms` → `{n}ms` under 1000, `{n.nn}s` under 10 000, `{n}s` above; `pct` → rounded `{n}%`.

## 16. Accessibility and selector notes for test authors

- **No `data-testid` anywhere.** Selectors must lean on: `getByRole('button', {name})`, exact text (`:text-is()`), `placeholder`, `title` attributes (`Run now (⌘R)`, `New suite`, `Back`, `Refresh`, `Revoke this key`, `Move up`, `Move down`, `Remove`, `Hide sidebar (⌥⌘S)`, `Show sidebar (⌥⌘S)`, `Create suite`, `Cancel`), and the CSS class vocabulary.
- `aria-pressed` on `.seg` buttons, `aria-current` on `.side-item`, `aria-expanded` on `.mb-item`, `role="switch"` + `aria-checked` on `.switch`, `role="alert"` on the auth error.
- Icon-only buttons mostly have `title` but **no `aria-label`** — `getByRole('button', {name})` still finds them via the title.
- Beware **two `role="alert"` nodes** on auth pages (see §5).
- Several strings use **typographic punctuation**: `“ ”` in the delete title, `’` in "don't"/"isn't"/"passwords don't match", `…` in "Analyze an app…", `⌘`/`⇧`/`⌥`/`⏎`/`↑↓` in hints. Matching with straight quotes will fail.
- `.toast`, `.label`, `.list-h`, `.toolbar-sub` and `.badge` are **uppercased by CSS**; `innerText` returns the transformed text. `textContent` returns the original. Prefer case-insensitive regex.
- Row action buttons live inside `.row-actions`, which is revealed on hover — Playwright's auto-hover on click handles this, but an explicit `.hover()` first is more reliable.
- `Menu` with an `anchor` is **portalled into `document.body`**, so it is not a DOM descendant of the row. Query it as `.popover`, not `.row .popover`. It also closes on **any scroll or resize**.
- Stat numbers animate (`CountUp`, ~780 ms; the ring ~1000 ms with a 60 ms delay). Use `expect(...).toHaveText()` which retries, not a bare `innerText()`.
- `.rise`, `heal-flash` and `slide-in` are CSS entry animations; nothing is `visibility:hidden` behind them, so they don't block clicks.

## 16b. Timing traps found while verifying **[LIVE]**

Every screen fetches its data *after* mount, so a locator count taken too early reads `0` and is indistinguishable from a genuinely empty result. Each of these cost a real test failure before it was fixed:

| Screen | Loading text to wait past |
|---|---|
| Tests | rows or the "No tests" card |
| Runs | `Loading runs…` |
| The Brain | `Reading the brain…` |
| Analyses | `Loading…` (one `/suites/:id/jobs` request **per suite**) |
| Usage → API keys | `Loading keys…` (`null` = loading, `[]` = empty — deliberately distinct) |
| Usage → Members | no loading text at all; wait for the first row |
| Run detail | `Waiting for the first step…` |

Two more:
- The run screen renders **several** `.list` containers (steps, history, DOM candidates). Scope step assertions to the list containing `STOPS ON FIRST UNHEALED FAILURE`, or a History list will be swept in.
- A cold Next.js route compiles on first hit and briefly shows the dev-server build screen, so a `page.goto` to a rarely-visited path needs `waitUntil: 'domcontentloaded'` plus a generous wait on `.sidebar`.

**The workspace is shared.** Another agent was creating records in the same demo tenant during this work, so absolute counts (total tests, total runs) drift between runs. Every count assertion here is either relative (before/after a specific action) or reconciles two figures the UI itself renders.

## 17. Backend endpoints the UI calls **[CODE]**

All through `/api/proxy/…`:

`GET|POST /suites` · `PATCH /suites/:id` · `GET /suites/:id/cases` · `POST /suites/:id/cases` · `POST /suites/:id/run` · `POST /suites/:id/analyze` · `POST /suites/:id/suggest` · `GET /suites/:id/jobs` · `GET /suites/:id/coverage` · `GET /suites/:id/app-brief` · `GET|PATCH|DELETE /cases/:id` · `POST /cases/:id/run` · `GET /cases?status=active[&origin=]` · `GET /runs?limit=` · `GET /runs/:id` · `POST /runs/:id/cancel` · `PATCH /runs/:id/steps/:stepId/verdict` · `GET /brain/selectors?limit=300` · `GET /tenants/:id/usage` · `GET /tenants/:id/usage/history?days=30` · `GET /tenants/:id/members` · `GET|POST /tenants/:id/keys` · `DELETE /tenants/:id/keys/:keyId` · `GET /media?key=`

Plus the Next-local auth routes `/api/auth/{login,demo,register,logout,me}`.

## 18. Where the code and the live app disagree **[DISAGREE]**

1. **"Runs are disabled on the demo account" is false.** The login page's demo caption promises *"Runs are disabled on the demo account, so nothing you click there spends tokens."* The `route.ts` comment says the same, deferring enforcement to a zero token budget. Live, the demo tenant has a **5,000,000-token monthly budget** (Usage tab) and clicking **Run now** on a case genuinely enqueued run `#7B46EA5B`, which executed and reached `failed`. The claim is only half true: runs on this workspace *do* cost nothing because every lookup resolves from cache (Free runs 100 %), but they are not disabled. **Tests must therefore treat "Run now" as a real, state-changing action.**

2. **The demo account is the workspace owner, not a read-only visitor.** The copy frames it as "look around"; `GET /api/auth/me` returns `role: "owner"`, and every destructive control (delete, revoke key, create admin key, signed-in exploration) is fully enabled. Verified live by creating a suite, a test, and an API key, and by deleting the test and revoking the key.

3. **`(app)/layout.tsx` never renders `{children}`**, so the four `page.tsx` files under `(app)/tests/**` and the components they import (`TestsDashboard`, `NewTestScreen`, `TestDetailScreen`, `RunReport`) are unreachable. The code implies four distinct screens at four URLs; live, all four URLs render the identical Tests screen. Confirmed by navigating to `/tests/new`, `/tests/some-id` and `/tests/a/runs/b/report` and landing on the Tests list every time. Note the routes still *exist* for routing purposes — an undefined path such as `/tests/abc/runs` genuinely 404s (§3).

4. **`organisms/login-form.tsx` / `signup-form.tsx` are stale.** They implement a different design ("Welcome Back!", "Forgot Password?", social auth, a `Passwords do not match` message with a straight apostrophe, and no name field). The live pages render `design/screen-auth.tsx` instead, whose messages differ (`Those passwords don’t match.`) and which validates the name first. Testing against the organism copy would fail on every string.

5. **The suite-health card ignores the suite filter.** The code computes `stats` once, workspace-wide, in `useDesignData` and passes the same object to `TestsScreen` regardless of `suiteFilter`. Live-confirmed: a newly created, entirely empty `AGENT-B Suite` displayed *"5 passed clean, 0 healed themselves, 9 need a human"* and a 23 % Green ring. The `AppBriefCard` and `CoverageStrip` beside it **are** suite-scoped, so the same card row mixes scopes.

6. **The Tests toolbar subtitle also ignores the filter** — it always reads `"{all cases} tests across {all suites} suites"`, even while a suite filter narrows the list to zero rows. (Consistent between code and live; noted because it looks like a bug.)

7. **The drag handle in the step editor is decorative.** `I.drag` is rendered on every step row, implying reordering by drag; there is no drag handler anywhere. Reordering only works through the Move up / Move down buttons.

8. **"New Suite" in the File menu does not create a suite.** It calls `go('author')`, i.e. it opens the New-test screen. Creating a suite actually happens via the sidebar `+`, the author screen's suite `+`, or the Analyze sheet's `New`.

9. **`Lights` (the traffic-light buttons) are inert.** They render `title="Close"` / `"Minimise"` / `"Fill the screen"` and take an `onAction`, but the shell passes `onLights={() => {}}` and the collapsed variant passes `onAction={() => {}}`. Clicking them does nothing — a `title` that promises behaviour the app does not have.

10. **`useCaseDetail` / `useAllCases` shape tolerance suggests the API is inconsistent.** The author screen accepts `baseUrl` *or* `base_url`, `suiteId` *or* `suite_id`, `rawText` *or* `raw_text`, and both `{case: …}` and a bare object. `useRunDetail` maps snake_case throughout. This is defensive code against a backend that is not uniform; it is not a UI bug but it means response-shape assumptions are unsafe.
