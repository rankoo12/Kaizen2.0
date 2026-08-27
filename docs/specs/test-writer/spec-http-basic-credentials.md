# Spec: HTTP Basic credentials as a suite setting

**Created:** 2026-08-18
**Status:** Proposed — awaiting founder go
**Owner:** test-writer / api / worker
**Amends:** `spec-recon-crawler.md` (§5 auth walls), `spec-authenticated-scope.md` (§5 consent),
`spec-oracle-delta-and-fidelity.md` §4 (the finding this closes)

---

## 0. Why now

`https://the-internet.herokuapp.com/basic_auth` answers **401** with a
`WWW-Authenticate: Basic realm="…"` challenge. That is not a form — it is the *browser's* sign-in
box, drawn by the browser chrome, with no DOM to fill in. Every login mechanism Kaizen has (the
login recipe: type, type, click) is a DOM mechanism, so the page is unreachable and unwritable.

Batch 2 taught the report to say so honestly: *"A page is behind HTTP authentication… Add the
username and password in the suite settings to include it."* **That setting does not exist yet.**
This spec builds it, and the ordering is deliberate — the finding is what makes the setting
discoverable, and the setting is what makes the finding actionable.

It is not a demo-site nicety: HTTP Basic is how a large share of staging environments are fenced
off, and a customer whose staging is behind Basic auth cannot use Kaizen at all today.

## 1. What a user does

In suite settings, a **Site access** section:

- *Username* and *Password*, plus the **origin** they apply to (defaulted to the suite's base URL
  origin, editable, one origin per pair; a suite may hold several).
- Saving stores them; reading them back is impossible by design (§3.3). The UI shows
  `admin · ●●●●●●` and a *Replace* button.
- A *Remove* button clears the pair.

From then on every browser context Kaizen opens for that suite — recon crawls, proving runs and
ordinary test runs — presents those credentials **to that origin only**.

## 2. Storage

New table, tenant-scoped and RLS-forced like every other tenant table:

```
suite_http_credentials
  id, tenant_id, suite_id, origin,          -- origin: scheme://host[:port], normalised
  username,                                  -- readable: it is not the secret
  password_ciphertext bytea, password_iv bytea, password_tag bytea,
  created_by, created_at, updated_at
  UNIQUE (tenant_id, suite_id, origin)
```

**Encryption at rest.** AES-256-GCM, key from `CREDENTIALS_KEY` (32 bytes, base64, Railway env —
never in the repo, never in `.env.example` as a real value). IV per row, auth tag stored. If
`CREDENTIALS_KEY` is absent the write is **refused with a loud 503**, never silently stored in
plaintext: a security control that degrades quietly is not a control.

Rationale for encrypting when a login recipe's password already lives in `test_steps.raw_text`:
that is a known gap, not a precedent to copy. This table is new, so it can start correct, and a
database dump — the realistic exposure for a hosted product — then yields nothing without the
Railway env.

## 3. API

### 3.1 Write
`PUT /suites/:suiteId/http-credentials` — `{ origin, username, password }`.
Requires the same role gate as authenticated-scope consent (owner/admin; §10.1 of
spec-authenticated-scope). Records `created_by`. Rejects a non-http(s) origin, an origin that is
not same-site as the suite's base URL **unless** the caller passes `allowForeignOrigin: true`
(so a staging asset host can be included deliberately, never accidentally).

### 3.2 Delete
`DELETE /suites/:suiteId/http-credentials/:origin`.

### 3.3 Read
`GET /suites/:suiteId/http-credentials` returns `[{ origin, username, configured: true, updatedAt }]`.
**No endpoint ever returns the password**, decrypted or otherwise. The only consumer of the
plaintext is the process that opens a browser context.

## 4. Getting them to the browser

Playwright takes them at context creation:

```ts
browser.newContext({ httpCredentials: { username, password, origin } })
```

The **`origin` field is mandatory in our usage**. Without it Playwright attaches the
`Authorization` header to every request the context makes, which would hand the customer's staging
password to any third-party host the page happens to load. With it, the header is scoped.

**The secret never rides the queue.** `RunJobPayload` gains `suiteId` (it already has it) and
nothing else — the worker loads and decrypts from the database at context creation. Putting a
password in a BullMQ payload would write it to Redis in plaintext and leave it there for the
job's retention window.

Three call sites open contexts and all three take the same helper
(`loadHttpCredentials(tenantId, suiteId)`):

- `recon/crawler.ts` — the crawl context.
- `workers/worker.ts` — the run context.
- the Test Writer's validation runs, which go through the worker already.

## 5. Recon

- A 401/407 whose origin has credentials configured is retried **once** with them attached; if it
  then answers 200 the page is crawled normally and no finding is raised.
- A 401/407 with no credentials configured produces the `requires_http_auth` finding built in §4 of
  the oracle-delta spec — unchanged, and now naming a setting that exists.
- A 401 that persists **with** credentials configured is a finding of its own: *"the credentials in
  suite settings were not accepted"* — a customer-fixable fact, and the one thing worse than no
  credentials is credentials that silently do nothing.
- `site_pages.requires_http_auth` (boolean) records the state so COMPREHEND and PLAN can tell "we
  could not see this page" from "this page is empty".

## 6. What must never happen

| Risk | Control |
|---|---|
| Password reaches a prompt | The plaintext exists only between the DB read and `newContext`. It is never on a `PageCapture`, never on a `StepAST`, never in `page_elements`. |
| Password reaches Redis | Not in the job payload; the worker reads it itself. |
| Password reaches logs | The loader returns an opaque object; `obs.log` never receives it. A log line may name the origin and the username, never the password. |
| Password reaches another origin | Playwright's `origin` scoping, plus the same-site check at write time. |
| Password reaches another tenant | RLS on `suite_http_credentials`, forced, same as every other tenant table; the loader is `tenantQuery`. |
| Password reaches a screenshot | Basic auth renders no DOM, so there is nothing to capture — no new control needed, recorded so the absence is deliberate. |
| Key rotation | `CREDENTIALS_KEY` supports a `KEY_ID` prefix column so a second key can be introduced without a downtime rewrite. v1 stores `key_id = 1`. |

## 7. Done when

- A suite whose base URL is `https://the-internet.herokuapp.com` with credentials
  `admin/admin` for that origin crawls `/basic_auth`, and the analyze proposes a test that
  navigates there and verifies the "Congratulations!" text.
- With the credentials removed, the same analyze produces the `requires_http_auth` finding and no
  test.
- With WRONG credentials, the analyze produces the "not accepted" finding.
- `GET` returns `configured: true` and no password. A DB dump of `suite_http_credentials` without
  `CREDENTIALS_KEY` yields nothing usable.

## 8. Out of scope

- Bearer tokens / API-key headers as a suite setting (same table shape would extend to it; not
  needed by any observed customer yet).
- Client certificates.
- Per-environment credentials (a suite has one set per origin; environments are a later concept).

## 9. Files

- `db/migrations/041_suite_http_credentials.sql`
- `src/modules/identity/credential-crypto.ts` (AES-256-GCM seal/open, key from env)
- `src/api/routes/suites.ts` (PUT/DELETE/GET)
- `src/modules/test-writer/recon/crawler.ts` (context, 401 retry, state)
- `src/workers/worker.ts` / `browser-pool.ts` (context)
- `packages/web/src/components/design/*` (Site access section — UI is handled in the design tool;
  this spec defines the data and the copy only)
- Tests: crypto round-trip + wrong-key failure, API redaction, RLS isolation, crawler retry.
