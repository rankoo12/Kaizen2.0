# Kaizen — Backend–Frontend Integration Spec

**Spec status:** Draft  
**Branch scope:** Two sequential branches (see §4)  
**Depends on:** All identity routes (merged on `main`), all test-hierarchy tables in DB schema  

---

## 1. Context & Goals

The backend and frontend currently operate independently. The backend has full identity (auth, users, tenants, members) and test-execution (suites, cases, steps, runs) APIs. The frontend has fully-styled screens but uses mock data and empty handlers.

This spec describes how to wire them together end-to-end across two focused branches:

| Branch | Scope | Depends on |
|--------|-------|------------|
| `feat/frontend/auth-integration` | Auth flow (login, signup, logout, route protection) | Nothing — pure frontend |
| `feat/tests/integration` | Backend test-case/suite routes + frontend test panel & new-test form | Auth branch merged |

---

## 2. Branch 1 — Auth Integration (`feat/frontend/auth-integration`)

### 2.1 Architecture: httpOnly Cookies via Next.js Route Handlers

JWT tokens must **never touch client-side JavaScript**. The pattern:

```
Browser (React)
  → POST /api/auth/login   (Next.js Route Handler — server-side)
      → POST /auth/login   (Kaizen API)  → sessionToken
      → POST /auth/token   (Kaizen API)  → { accessToken, refreshToken }
      ← sets httpOnly cookies: kaizen_access, kaizen_refresh
  ← 200 OK  (with user profile in JSON body)
```

All subsequent API calls from the frontend go through `/api/proxy/...` Route Handlers that:
1. Read `kaizen_access` from the incoming request cookies (server-side only)
2. Forward the request to the Kaizen API with `Authorization: Bearer <accessToken>`
3. On 401 (expired token): attempt refresh, retry once, then return 401

This means the React client code **never sees a token** — it just calls `/api/...` and reads JSON.

### 2.2 Environment Variable

Add to `packages/web/.env.local` (and document in `packages/web/.env.example`):
```
KAIZEN_API_URL=http://localhost:3000
```

Used only in Next.js Route Handlers (server-side). Never prefix with `NEXT_PUBLIC_`.

### 2.3 Files to Create/Modify

#### `packages/web/src/lib/cookies.ts` (new)
Server-side cookie helpers (used in Route Handlers only):

```typescript
// Constants
export const ACCESS_COOKIE  = 'kaizen_access'
export const REFRESH_COOKIE = 'kaizen_refresh'

// Cookie options for Set-Cookie
export const ACCESS_COOKIE_OPTIONS  = { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 }        // 1 hour
export const REFRESH_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 } // 30 days
```

#### `packages/web/src/lib/api.ts` (new)
Server-side fetch utility for Route Handlers (not for client components):

```typescript
// baseUrl: process.env.KAIZEN_API_URL
// attach Authorization header if accessToken provided
// on 401: attempt refresh via POST /auth/refresh
// throws ApiError with { status, code, message } on non-2xx
export async function apiRequest<T>(
  path: string,
  options: RequestInit & { accessToken?: string }
): Promise<T>
```

#### `packages/web/src/app/api/auth/login/route.ts` (new)
```
POST /api/auth/login
Body: { email: string, password: string }

1. Call Kaizen POST /auth/login → { sessionToken, tenants }
2. Auto-select tenants[0].id (users only have one tenant — their personal workspace)
3. Call Kaizen POST /auth/token with { sessionToken, tenantId }
4. Set httpOnly cookies: kaizen_access, kaizen_refresh
5. Return 200 with { user: { id, email, displayName, avatarUrl }, tenantId }
```

#### `packages/web/src/app/api/auth/register/route.ts` (new)
```
POST /api/auth/register
Body: { email: string, password: string, displayName?: string }

1. Call Kaizen POST /auth/register → { user, tenant, tokens }
   (register creates user + personal tenant + issues JWT pair in one step)
2. Set httpOnly cookies: kaizen_access, kaizen_refresh
3. Return 200 with { user: { id, email, displayName, avatarUrl }, tenantId }
```

#### `packages/web/src/app/api/auth/logout/route.ts` (new)
```
POST /api/auth/logout

1. Read kaizen_access cookie (server-side)
2. Call Kaizen POST /auth/logout with Authorization header
3. Clear both cookies (set maxAge: 0)
4. Return 200 { ok: true }
```

#### `packages/web/src/app/api/auth/me/route.ts` (new)
```
GET /api/auth/me

1. Read kaizen_access cookie
2. If missing → return 401
3. Call Kaizen GET /users/me with Authorization header
4. On 401 from Kaizen: attempt token refresh (POST /auth/refresh with kaizen_refresh cookie)
   - If refresh succeeds: set new kaizen_access cookie, retry GET /users/me, return result
   - If refresh fails: clear both cookies, return 401
5. Return 200 with user profile
```

#### `packages/web/src/app/api/proxy/[...path]/route.ts` (new)
Generic proxy for all authenticated API calls from the frontend. Forwards GET/POST/PATCH/DELETE to the Kaizen API with the access token injected:

```
All methods → /api/proxy/[...path]
  e.g. GET /api/proxy/suites → Kaizen GET /suites
       POST /api/proxy/cases/123/run → Kaizen POST /cases/123/run

1. Read kaizen_access cookie (server-side)
2. If missing → 401
3. Forward request to Kaizen API at KAIZEN_API_URL/[...path]
4. On 401 from Kaizen → refresh → retry once
5. Return Kaizen's response as-is
```

#### `packages/web/src/context/auth-context.tsx` (new)
Client-side React context storing the _result_ of `/api/auth/me` (no token stored):

```typescript
type AuthUser = {
  id: string
  email: string
  displayName: string
  avatarUrl: string | null
  tenantId: string
}

type AuthContextValue = {
  user: AuthUser | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>   // calls /api/auth/login
  register: (email: string, password: string, displayName?: string) => Promise<void>
  logout: () => Promise<void>  // calls /api/auth/logout, then router.push('/login')
}
```

On mount: calls `GET /api/auth/me`. Exposes `isLoading` so pages can show a skeleton.

#### `packages/web/src/app/layout.tsx` (modify)
Wrap children in `<AuthProvider>`.

#### `packages/web/src/middleware.ts` (new)
Next.js middleware for route protection:

```typescript
// Protected routes: /tests, /tests/:path*
// On request to protected route: check for kaizen_access cookie
// If missing → redirect to /login?next=<original-path>
// Public routes: /, /login, /signup — pass through
```

#### `packages/web/src/components/organisms/login-form.tsx` (modify)
Wire `onSubmit` to `auth.login(email, password)`. On success: `router.push('/tests')`. On error: show error message in the form.

#### `packages/web/src/components/organisms/signup-form.tsx` (modify)
Wire `onSubmit` to `auth.register(email, password)`. On success: `router.push('/tests')`. On error: show error message.

#### `packages/web/src/components/molecules/profile-dropdown.tsx` (modify)
Wire the Logout menu item to `auth.logout()`.  
Wire Settings to route to tenant settings (placeholder — `/settings` not yet built, can be disabled/hidden for now).  
Show `user.displayName` and `user.email` in the dropdown header.

### 2.4 Error Handling

All auth errors should surface in the form as a simple inline error message (not a toast). Specific cases:

| Kaizen API error | Frontend message |
|-----------------|-----------------|
| 401 on login | "Invalid email or password" |
| 409 on register (email taken) | "An account with this email already exists" |
| 422/400 validation | Show field-level error if possible, else generic "Please check your details" |
| 5xx / network | "Something went wrong. Please try again." |

### 2.5 What is NOT in this branch

- Forgot password / reset password flow (backend routes exist but no UI designed yet)
- Email verification flow  
- Tenant settings page  
- Any test-related functionality  

---

## 3. Branch 2 — Tests Integration (`feat/tests/integration`)

Depends on Branch 1 being merged. All frontend API calls go through `/api/proxy/...` (the Route Handler proxy from §2), so JWT handling is already solved.

### 3.1 Backend: Missing Test-Case/Suite Routes

The DB has the full test hierarchy (`test_suites`, `test_cases`, `test_steps`, `test_case_steps`) but no API routes expose it. These must be built.

All new routes require JWT auth (`requireAuth` middleware). Tenant isolation is enforced at both the JWT (`request.tenantId`) and DB (RLS via `withTenantTransaction`) levels.

#### `src/api/routes/test-cases.ts` (new file)

**Suites:**

```
GET  /suites
  → List all suites for the authenticated tenant
  → Response: Suite[] with { id, name, description, tags, caseCount, createdAt, updatedAt }

POST /suites
  → Create a new suite
  → Body: { name: string, description?: string, tags?: string[] }
  → Response 201: Suite

PATCH /suites/:suiteId
  → Update suite name / description / tags
  → Body: { name?: string, description?: string, tags?: string[] }
  → Requires admin role
  → Response: Suite

DELETE /suites/:suiteId
  → Delete suite and all its test cases (cascade)
  → Requires admin role
  → Response 204
```

**Test Cases:**

```
GET  /suites/:suiteId/cases
  → List test cases in a suite, ordered by created_at DESC
  → Include for each case: last run status, last run id, last run completedAt
  → Response: CaseSummary[] with {
      id, name, base_url, createdAt, updatedAt,
      lastRun: { id, status, completedAt } | null
    }

POST /suites/:suiteId/cases
  → Create a new test case with its initial steps
  → Body: {
      name: string,
      base_url: string,
      steps: string[]   // array of raw NL step texts, min 1
    }
  → Handler:
    1. Insert test_cases row
    2. For each step text: insert test_steps row (with position, content_hash = SHA-256(normalise(text)))
    3. Insert test_case_steps join rows (is_active = true)
    4. Return 201 with full case object including steps
  → Response 201: Case with steps

GET  /cases/:caseId
  → Get single test case with its active steps and last 10 run summaries
  → Response: {
      id, name, base_url, suiteId, createdAt, updatedAt,
      steps: { id, position, rawText, contentHash }[],
      recentRuns: { id, status, triggeredBy, createdAt, completedAt }[]
    }

PATCH /cases/:caseId
  → Update test case name, base_url, or steps
  → Body: { name?: string, base_url?: string, steps?: string[] }
  → For step edits: follow immutable step versioning protocol
    (insert new test_steps row, set old test_case_steps is_active=false,
     insert new test_case_steps row — preserving full edit history)
  → Response: updated Case with steps

DELETE /cases/:caseId
  → Soft-delete or hard-delete the test case
  → Response 204

POST /cases/:caseId/run
  → Enqueue a run for a specific test case
  → Body: { baseUrl?: string }  (overrides case.base_url if provided)
  → Handler:
    1. Fetch active steps for the case (from test_case_steps WHERE is_active=true, ordered by position)
    2. Extract raw_text from test_steps
    3. Call LearnedCompiler.compileMany(rawTexts) → compiledSteps
    4. Insert runs row (case_id, suite_id, triggered_by='web', status='queued', environment_url)
    5. Enqueue BullMQ job on kaizen-runs queue
    6. Return 202: { runId, status: 'queued' }
```

**Runs list:**

```
GET /runs
  → List runs for the authenticated tenant with filters
  → Query params: suiteId?, caseId?, status?, page? (default 1), limit? (default 20, max 100)
  → Response: {
      runs: RunSummary[],
      total: number,
      page: number,
      totalPages: number
    }
  → RunSummary: { id, caseId, caseName, suiteId, suiteName, status, triggeredBy, createdAt, completedAt }
```

Register the new route file in `src/api/index.ts` (or wherever routes are registered).

### 3.2 Frontend: Tests Panel Redesign

Remove the 1000 mock tests entirely. Replace with real data from the API.

#### Data model change

The panel now shows **suites as tabs/sections** and **test cases as cards/rows** within each suite. The "test square" grid (1000 colored squares) is replaced with a structured list grouped by suite.

Each test case row shows:
- Name
- Suite name
- Last run status (Passed / Failed / Pending — where Pending = never run)
- Last run timestamp
- "Run" button (per-case)

The action bar at the bottom (multi-select: Run selected / Archive selected) remains.

#### New hooks

**`packages/web/src/hooks/use-suites.ts`**
```typescript
// GET /api/proxy/suites
// Returns { suites: Suite[], isLoading, error, refetch }
```

**`packages/web/src/hooks/use-cases.ts`**
```typescript
// GET /api/proxy/suites/:suiteId/cases
// Returns { cases: CaseSummary[], isLoading, error, refetch }
// Accepts suiteId as param — called per-suite in the panel
```

**`packages/web/src/hooks/use-run-poller.ts`**
```typescript
// Takes runId and a callback onComplete(run)
// Polls GET /api/proxy/runs/:id every 1500ms
// Stops when status is one of: 'passed' | 'failed' | 'healed' | 'cancelled'
// Calls onComplete with the final run object
```

#### Modified files

**`packages/web/src/components/organisms/tests-panel.tsx`** (major rewrite)
- Remove: all mock data (`generateMockData`, `TestSquare`, all mock types)
- Remove: comparison mode (no baseline concept yet)
- Remove: smart selectors (All Failed, Regressions)
- Keep: selection logic, action bar, search, toast notifications, force-pass verdict modal

New structure:
```
<TestsPanel>
  Header: search, suite filter tabs, "New Test" button (→ /tests/new)
  
  For each suite (from useSuites):
    Suite section header with name + case count
    For each case (from useCases(suite.id)):
      <TestCaseRow> — name, status badge, last run timestamp, Run button
  
  Fixed bottom action bar (visible when ≥1 case selected):
    "Run Selected" → POST /api/proxy/cases/:id/run for each selected
    "Delete Selected" → DELETE /api/proxy/cases/:id for each selected
</TestsPanel>
```

Running a case:
1. Call `POST /api/proxy/cases/:caseId/run` → get `{ runId }`
2. Start `useRunPoller(runId)` for that case
3. Show spinner on the case row
4. On poll completion: update the case's status in local state, show toast

**`packages/web/src/components/molecules/suite-selector.tsx`** (modify)
Populate the dropdown from `useSuites()` instead of hardcoded values.

#### Modified new-test form

**`packages/web/src/components/organisms/new-test-panel.tsx`** (modify)
Wire the form submit to `POST /api/proxy/suites/:suiteId/cases` with:
```json
{
  "name": "<test name>",
  "base_url": "<base url from form>",
  "steps": ["step 1 text", "step 2 text", ...]
}
```
On success: toast "Test created", redirect to `/tests`.  
On error: inline error message.

The suite selector in this form should load real suites from `useSuites()`. Include a "Create new suite" inline option (calls `POST /api/proxy/suites` first, then uses the new suite's id).

### 3.3 Types Shared Between Frontend Hooks and Route Responses

Create `packages/web/src/types/api.ts` with the TypeScript types matching the API responses:

```typescript
export type Suite = {
  id: string
  name: string
  description: string | null
  tags: string[]
  caseCount: number
  createdAt: string
  updatedAt: string
}

export type CaseSummary = {
  id: string
  name: string
  base_url: string
  createdAt: string
  updatedAt: string
  lastRun: {
    id: string
    status: 'queued' | 'running' | 'passed' | 'failed' | 'healed' | 'cancelled'
    completedAt: string | null
  } | null
}

export type CaseDetail = CaseSummary & {
  suiteId: string
  steps: {
    id: string
    position: number
    rawText: string
    contentHash: string
  }[]
  recentRuns: RunSummary[]
}

export type RunSummary = {
  id: string
  caseId: string | null
  caseName: string | null
  suiteId: string | null
  suiteName: string | null
  status: 'queued' | 'running' | 'passed' | 'failed' | 'healed' | 'cancelled'
  triggeredBy: 'web' | 'api' | 'cli' | 'schedule'
  createdAt: string
  completedAt: string | null
}

export type RunDetail = RunSummary & {
  environment_url: string
  total_tokens: number
  stepResults: StepResult[]
}

export type StepResult = {
  id: string
  step_id: string | null
  status: 'passed' | 'failed' | 'healed' | 'skipped'
  cache_hit: boolean
  selector_used: string | null
  duration_ms: number
  error_type: string | null
  failure_class: string | null
  screenshot_key: string | null
  tokens: number
  healingEvents: HealingEvent[]
}

export type HealingEvent = {
  id: string
  failure_class: string
  strategy_used: string
  attempts: number
  succeeded: boolean
  duration_ms: number
}
```

### 3.4 What is NOT in this branch

- Editing existing test cases (step versioning edit flow)
- Run history / run detail view (exists in DB, no UI designed yet)
- Comparison / regression mode (no baseline concept yet)
- Settings page
- Billing / usage view

---

## 4. Branching Decision

**Two sequential branches.** Do not combine into one.

**Reason:** Auth is a foundational dependency. Every hook in Branch 2 relies on the proxy Route Handler and auth context from Branch 1. Building them in parallel would mean duplicating auth scaffolding or having untested cross-branch imports. Sequential is cleaner — Branch 1 is small, focused, and reviewable in isolation.

```
main
  └── feat/frontend/auth-integration   ← Branch 1 (start here)
        └── feat/tests/integration     ← Branch 2 (branch off after 1 is merged)
```

**Branch 1 scope:** ~8 files, mostly new. No backend changes.  
**Branch 2 scope:** ~5 backend files (new route + service), ~10 frontend files (hooks, types, panel rewrite).

---

## 5. Open Questions / Decisions Made

| Question | Decision |
|----------|----------|
| JWT storage | httpOnly cookies via Next.js Route Handler proxy |
| Multi-tenant login picker | Skipped — users have exactly one tenant (personal workspace created at registration) |
| Single-tenant invariant | A user registered via `POST /auth/register` always gets a personal tenant. The membership system exists for future team features but is not exposed in the UI for now. |
| Mock tests in TestsPanel | Remove entirely — they were a UI POC, not a design target |
| Forgot password UI | Not in scope for these branches — no screen designed |
| New test → suite creation | Inline "create new suite" in the suite selector dropdown on the new-test form |
| Test case "archive" | Implemented as `DELETE /cases/:caseId` — no soft-delete / archive concept in the current schema |
