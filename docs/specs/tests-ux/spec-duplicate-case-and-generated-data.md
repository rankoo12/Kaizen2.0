# Spec: Duplicate Test Case + Generated Form Data

Created: 2026-06-20
Updated: 2026-06-20

## 0. Motivation

Two authoring conveniences:

1. **Duplicate a test case** — clone a case's steps and configuration into a new
   case *without* copying its run history, screenshots, or results. Lets users
   fork a working test as a starting point.
2. **Generated form data** — let a step reference per-run generated values
   (`{{firstName}}`, `{{email}}`, `{{password}}`, …) that are unique on every
   run. This avoids "user already exists" failures when a test registers an
   account, and the run "knows" the values so later steps can reuse/assert them.
   A per-step UI "tools" inserter drops these tokens into step text.

Both build on existing machinery: duplication mirrors the case-create path;
generated data reuses the run-scoped variable store + `{{token}}` interpolation
from [spec-engine-capabilities-assert-random-capture.md](../workers/spec-engine-capabilities-assert-random-capture.md) §3.

## 1. Duplicate test case

### 1.1 Endpoint

`POST /cases/:caseId/duplicate` (auth, tenant-scoped).

Body (optional): `{ name?: string }` — defaults to `"<original name> (copy)"`.

### 1.2 Behaviour

Within a tenant transaction:
1. Load the source case (404 if not found / not in tenant).
2. Load its **active** steps (`test_case_steps.is_active = true`, ordered).
3. Insert a new `test_cases` row in the same suite with the new name and the
   source `base_url`.
4. Recreate each step (`test_steps` + `test_case_steps`) in order — same
   `raw_text` / `content_hash`, fresh ids, `position` preserved.

**Not copied:** `runs`, `step_results`, screenshots, healing events, verdicts.
The clone starts with empty history.

### 1.3 Response

`201` with the same shape as `POST /suites/:suiteId/cases` (the new case +
steps + `lastRun: null`).

### 1.4 UI

A "Duplicate" action on each case (dashboard row menu and/or the detail page
header). On success, navigate to the new case.

## 2. Generated form data

### 2.1 Tokens

A fixed catalogue of generated variables, produced fresh per run:

| Token | Example | Notes |
|---|---|---|
| `{{firstName}}` | `Jordan` | from a name pool |
| `{{lastName}}`  | `Tester` | from a name pool |
| `{{email}}`     | `jordan.tester.k3f9x@example.com` | **random local-part suffix per run** → unique |
| `{{password}}`  | `Aa1!k3f9xQ` | meets common strength rules; reused for confirm-password by using the same token |
| `{{phone}}`     | `+1 555 014 2783` | |
| `{{company}}`   | `Tester LLC` | |
| `{{username}}`  | `jordan.tester.k3f9x` | email local-part |

The email/username share the same random suffix so they are internally
consistent within a run.

### 2.2 Generation point

Generated **at run start in the API** (`POST /cases/:caseId/run`), NOT at
compile time (compile-time generation risks the AST cache reusing stale values
and re-triggering "user exists"). The generated map is passed through the queue
payload and seeded into the worker's run context.

### 2.3 Wiring

- New module `src/modules/test-data/generate.ts` exporting
  `generateFormData(): Record<string,string>` — pure, dependency-free, uses a
  random suffix for uniqueness.
- `RunJobPayload` gains optional `seedVariables?: Record<string,string>`.
- The API generates the map and includes it in `queue.add('run', …)`.
- `runStepLoop` accepts optional seed variables and initialises
  `RunContext.variables` with them (instead of always `{}`).
- Steps reference `{{token}}` exactly like `{{selectedItem}}`; the worker's
  existing `interpolateStep` resolves them. **No execution-engine change.**

### 2.4 Consistency with capture

Generated variables and captured variables share one namespace. A captured
value (e.g. `{{selectedItem}}`) and a generated one (`{{email}}`) are both just
keys in `RunContext.variables`. If a step both references and captures, the
reference resolves against the pre-seeded/earlier-captured value first.

### 2.5 UI "tools" inserter

Per step row in the steps editor, a small "tools" / "+ variable" control opens
a menu of the tokens in §2.1. Selecting one inserts `{{token}}` at the cursor
(or appends) into that step's text. Pure client-side text manipulation; the
token travels to the backend as ordinary step text.

## 3. Out of scope

- User-defined custom variables / value editing in the UI.
- Locale-specific name/phone formats.
- Persisting generated values beyond the run (they live in the run context and,
  where a step captures them, in `step_results`).

## 4. Test plan

- **Duplicate**: unit/integration — duplicating a case creates a new case with
  identical active steps, a distinct id, same suite + base_url, and zero runs;
  source case is unchanged.
- **generateFormData**: unit — returns all tokens; `email`/`username` share the
  suffix; two calls produce different emails (uniqueness); password meets the
  strength regex.
- **Seed wiring**: unit — `runStepLoop` seeds `RunContext.variables` from the
  provided map; a `{{email}}` token in a step interpolates to the seeded value.

## 5. Acceptance criteria

1. `POST /cases/:caseId/duplicate` clones steps + config, no history; UI action
   navigates to the clone.
2. A run started for a case with `{{email}}` steps registers a unique account
   each run (no "user already exists").
3. The per-step tools menu inserts `{{token}}` tokens into step text.
4. `npm run typecheck` + `npm run lint` clean; tests in §4 added and green.
