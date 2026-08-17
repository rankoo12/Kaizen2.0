# Runbook — moving the runtime off the superuser

Created: 2026-08-17
Status: **READY TO SWITCH.** Role provisioning built and proven; both design
blockers fixed (037 shared brain, 038 API-key lookup); the query conversion in
§3(a) is complete and the full application has been run and exercised as the
unprivileged role — reads, writes, JWT auth, API-key auth, the shared brain.
The isolation suite is 7/7. What remains is operational (§4 steps 4–8), which is
deliberately not done by a PR: provisioning the role in each environment and
flipping `DATABASE_URL` is a deploy decision with a one-setting rollback.
Spec: `docs/specs/test-writer/spec-app-entity.md` §5 (Decision 5, corrected)

---

## 1. Why

Kaizen's tenant tables have carried row-level security policies since migration
029, and `FORCE ROW LEVEL SECURITY` since 036. None of it applies, because the
application connects as **`kaizen`, a superuser**, and Postgres exempts
superusers from RLS unconditionally.

Measured on the dev database, with FORCE applied, running the same
predicate-free `SELECT * FROM site_pages`:

| connected as | rows returned |
|---|---|
| `kaizen` (today's runtime) | **59 — every tenant's** |
| an unprivileged role | 30 — exactly the current tenant's |

The mechanism works. The application does not use it. Until that changes,
"tenant isolation is enforced by the database" is not a true statement, and
should not be made to a customer or a security reviewer.

## 2. What is already built and proven

- `db/roles/app_runtime_role.sql` — idempotent provisioning. Creates the role
  `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, grants DML on existing
  tables and sequences, and — the step people miss — `ALTER DEFAULT PRIVILEGES`
  **for the migration role** so tables created by future migrations are covered.
  Without that, the next migration ships a table the runtime cannot read and the
  failure shows up at runtime, not at deploy. Re-asserts the role's flags on
  every run and refuses to report success if it still has SUPERUSER/BYPASSRLS.
- `scripts/provision-app-role.ts` — runs it against `DATABASE_ADMIN_URL`.
  Password comes from `KAIZEN_APP_DB_PASSWORD` and is never defaulted.
- `scripts/migrate.js` now connects via `DATABASE_ADMIN_URL || DATABASE_URL`.
  The fallback means existing single-role deployments are unaffected; setting
  the admin URL is what opts a deployment into the split.
- `src/db/__tests__/tenant-isolation.integration.test.ts` — **7/7 pass under an
  unprivileged role** (6/7 under the superuser, with the seventh failing by
  design). It proves the real properties: a tenant sees only its own rows *with
  no predicate in the SQL*, a cross-tenant read returns nothing, a cross-tenant
  INSERT is refused, and a query that forgets the tenant errors instead of
  leaking.

Provisioned and verified locally:

```bash
DATABASE_ADMIN_URL=postgresql://kaizen:kaizen@localhost:5432/kaizen \
KAIZEN_APP_DB_ROLE=kaizen_app KAIZEN_APP_DB_PASSWORD='...' \
npx tsx scripts/provision-app-role.ts

DATABASE_URL=postgresql://kaizen_app:...@localhost:5432/kaizen \
DATABASE_ADMIN_URL=postgresql://kaizen:kaizen@localhost:5432/kaizen \
npx jest --config jest.integration.config.ts tenant-isolation
```

## 3. Why the switch is blocked

Running the API as `kaizen_app` boots, authenticates, and serves `/suites` and
`/cases`. **`GET /runs` returns 500.**

The reason generalises, and it is the thing to understand before planning this
work: **`FORCE` is only about the table's owner. For any non-owner role, plain
`ENABLE ROW LEVEL SECURITY` is already enough.** So the switch does not activate
5 tables — it activates all **18** that have RLS enabled, including `runs`,
`test_cases`, `test_suites`, `step_results`, `run_events` and `selector_cache`.

Three distinct pieces of work follow. **(b) and (c) are done; only (a) — the mechanical conversion — remains.**

**a. ~~~57 bare-pool queries, across 19 files, must move inside a tenant
transaction.~~ DONE.** Every query against an RLS-enabled table now runs via
`tenantQuery` / `tenantPool` / `withTenantTransaction`. What was deliberately
left on the bare pool: `element_archetypes` and `archetype_failures` (global,
no RLS by design), `tenants` / `users` / `memberships` (no RLS), and the two
`api_key_*` SECURITY DEFINER calls in the auth middleware (which must run before
a tenant is known — that is their purpose). Verified with the app running as
`kaizen_app`: `/suites`, `/cases`, `/runs`, `/runs/:id`, `/runs/:id/report`,
`/brain/selectors`, `/tenants/:id/usage` all 200; a suite + case create round-trips;
API-key auth resolves via the definer function and a bogus key is a clean 401;
the resolver's L4 query shape sees all 117 shared rows. Original count, by file:

| area | files | queries |
|---|---|---|
| worker + consumers + run logger | 3 | 12 |
| routes (`runs`, `test-writer`, `test-cases`, `brain`, `auth`, middleware) | 6 | 20 |
| element resolver + healing engine | 5 | 7 |
| shared pool, tenant service, billing, validation runner | 4 | 18 |

The Test Writer pipeline's share of this is already done (PR #78). The pattern
is `tenantQuery(tenantId, sql, params)` from `src/db/transaction.ts` — one
statement per transaction, because the worker holds work open for minutes and a
long-lived transaction would trade a security fix for pool exhaustion.

**b. ~~`api_keys` is a chicken-and-egg problem.~~ FIXED — migration 038.** Its
policy is `tenant_id = current_setting('app.current_tenant_id')`, but the auth
middleware reads a key *in order to discover which tenant it belongs to*, so
under RLS that one lookup could never succeed. Resolved with a `SECURITY DEFINER`
function rather than a policy exception: `api_key_lookup(hash)` returns tenant,
scope and expiry and nothing else — cannot list, cannot search by tenant, cannot
return the hash. Holding a valid hash IS the credential, so answering "whose is
it" leaks nothing the caller did not already prove. `search_path` is pinned so
the function cannot be pointed at a shadow table. A companion `api_key_touch`
keeps `last_used_at` writes off the direct path.

Proven under the unprivileged role with no tenant set: a direct `SELECT` on
`api_keys` errors; the definer function answers. Then end to end: a bogus API
key is a clean 401 and a valid one authenticates — the request now fails later,
inside the *route handler*, on an un-scoped `runs` read that belongs to (a).
Which is the point: authentication is no longer in the way.

**c. ~~`selector_cache` would silently lose the global brain.~~ FIXED —
migration 037.** Its policy was the same tenant-equality predicate, but shared
rows are stored with `tenant_id IS NULL`, and `NULL = anything` is never true, so
every shared row failed the check. Under a non-owner role the cross-tenant cache
behind `firstRunTokens: 97 → lastRunTokens: 0` would simply have stopped being
read — no error, just a collapse in hit rate and a rise in token spend that
nothing announces.

`037_shared_brain_rls.sql` rewrites the policy to admit shared rows explicitly,
for reads and for contributions:

```sql
USING       (tenant_id = current_setting('app.current_tenant_id')::uuid
             OR (is_shared AND tenant_id IS NULL))
WITH CHECK  (same)
```

Proven under the unprivileged role: tenant A sees its own row **and** the shared
row, and does not see tenant B's; contributing a shared row succeeds; planting a
row in tenant B's account is refused and does not land. `selector_cache_aliases`
was deliberately left alone — its `tenant_id` is `NOT NULL` and it has no
`is_shared` column, so an alias always belongs to one tenant and its policy was
already correct.

Nothing about *what* is shared changed. Promotion is still gated by
`tenants.global_brain_opt_in` in `shared-pool.service.ts`, and a shared row still
carries selectors and attribution, never tenant data. The migration only makes
the database agree with a sharing decision the product had already made.

## 4. The order, when it is time

Sequencing matters more than any individual step here: getting it wrong locks
the product out of its own database.

1. ~~Fix (b) and (c)~~ — both shipped (migrations 037, 038).
2. ~~Convert the ~57 queries (a)~~ — done, in this branch.
3. `FORCE` the remaining tenant tables (they are already ENABLEd, so this only
   matters if the runtime is ever also the owner — keep it for defence in depth).
4. Provision the role in **every** environment first — dev compose, CI, staging,
   production — and confirm `\du` shows `NOSUPERUSER`, `NOBYPASSRLS`.
5. Set `DATABASE_ADMIN_URL` to the *existing* superuser URL **before** touching
   `DATABASE_URL`, so migrations keep working the moment the app URL changes.
6. Re-run `provision-app-role.ts` after the latest migration, so any table added
   since the role was created is covered.
7. Flip `DATABASE_URL` to the app role in staging. Run the integration test —
   all 7 must pass, including "the application's own role cannot bypass
   row-level security". Exercise a real run end to end and confirm cache hits
   still resolve from memory (this is the (c) regression check).
8. Flip production. Roll back by pointing `DATABASE_URL` back at the admin URL;
   nothing else needs to change, which is what makes this reversible.

**Never** grant the app role `SUPERUSER` or `BYPASSRLS` to resolve an incident.
That silently restores today's situation while looking like a fix, and the
provisioning script will start failing its own assertion — which is the point.

## 5. Railway — the concrete flip

Kaizen deploys on Railway (`Dockerfile`: the pre-deploy command runs
`npm run db:migrate` in the production image). What decides the exact steps is
**where the production Postgres lives**, which the repo does not record —
`docs/specs/deployment/spec-deployment.md` describes an older Render + Supabase
plan, and the Railway migration is documented only in the Dockerfile.

Two cases. Find out which one you are in first: connect with the current
`DATABASE_URL` and run
`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;`

**Case A — Railway Postgres plugin (or any DB where the current role is a
superuser).** Same as dev. Steps 4–8 of §4 apply verbatim:

Which services connect to Postgres, from the code (not from the service names):
**API, worker-1, test-writer, persistence-db-updates** — four. `screenshotter`
touches only Redis and object storage and needs nothing here. Railway's
**Shared Variables** (project → Settings) is the right place to define these
once and reference from all four, so there is one place to rotate the password.

```
# 1. In Railway → the Postgres service → Variables: copy DATABASE_URL.
#    Set it on ALL FOUR Postgres-using services as DATABASE_ADMIN_URL (new var).
#    Strictly only the API runs migrations (Dockerfile pre-deploy), but having
#    it everywhere means a manual `railway run npm run db:migrate` against any
#    service works instead of failing with a confusing "permission denied".
# 2. Choose a strong password (letters+digits, 32+ chars — URL-safe, no
#    escaping); set on the same four services:
#      KAIZEN_APP_DB_ROLE=kaizen_app
#      KAIZEN_APP_DB_PASSWORD=<generated>
# 3. Provision, from a one-off shell (railway run) or your machine with the
#    admin URL:
DATABASE_ADMIN_URL="$RAILWAY_DB_URL" KAIZEN_APP_DB_ROLE=kaizen_app KAIZEN_APP_DB_PASSWORD='<generated>' npx tsx scripts/provision-app-role.ts
# 4. Verify before touching anything user-facing.
#    ⚠ NOT from your laptop through the public proxy. Found live 2026-08-17:
#    Railway's TCP proxy (*.proxy.rlwy.net) accepts the default `postgres`
#    login and drops any OTHER role's connection before Postgres sees it —
#    "server closed the connection unexpectedly" / ECONNRESET, with or without
#    SSL, while the role is perfectly healthy (rolcanlogin t, no limit, no
#    expiry). So the isolation suite cannot be run against production from
#    outside; kaizen_app is reachable only on the internal network. Prove the
#    role from inside instead:
#      railway link            # choose the Postgres service
#      railway ssh             # lands in the Postgres container (has psql)
#      psql -U kaizen_app -d railway -h localhost -c "select current_user"
#    → prints kaizen_app. That is the acceptance check for the role itself.
#    The isolation suite's cross-tenant assertions were proven on dev with an
#    identical role definition; the production check is that the role exists,
#    is NOSUPERUSER/NOBYPASSRLS (the provision script asserts it), and logs in.
# 5. Only now: change DATABASE_URL on the same four services to the
#    kaizen_app URL — the INTERNAL one (postgres.railway.internal): take the
#    existing DATABASE_URL and swap `postgres:<pw>` for `kaizen_app:<pw>`,
#    nothing after the `@` changes. Leave DATABASE_ADMIN_URL as the original.
#    Flip persistence-db-updates FIRST on its own, watch its logs come up with
#    no "permission denied" / "current_tenant_id" errors, then the other three.
#    screenshotter is untouched throughout.
# 6. Post-flip: open the app — view a suite, open a run, load the Brain page.
#    All surfaces exercised locally under this role.
#    Migrations keep working (they use the admin URL); the app runs restricted.
# Rollback: set DATABASE_URL back to the admin URL. Nothing else changes.
```

**Case B — Supabase (or any managed Postgres where the app role is already NOT
a superuser).** Then RLS may *already* be enforcing in production for
non-owner roles, and this branch's query conversion is what has been keeping —
or will keep — the app working there. Check `rolsuper` first; if it is `f`, the
role is likely the table owner (Supabase's `postgres`), which is exempt from
policies **only on tables that are not FORCEd**. Migration 036 FORCEd five
tables, so on this shape 036 activates enforcement on those five at deploy —
which is exactly why the Test Writer paths were converted in the same PR. The
switch to a separate app role is still worth doing (owner exemption on the
other thirteen tables is a hole), and the steps are the same as Case A with
Supabase's connection string as the admin URL and `?sslmode=require` on both
URLs. `src/db/pool.ts` does not currently set `ssl`; if the provider requires
it, add `ssl: { rejectUnauthorized: false }` when `DB_SSL=true` before the
flip — the deployment spec §3.4 called for this and it was never wired.

In either case the acceptance check is the same: the isolation suite at 7/7
against production, run once with the new URL before the app is pointed at it.

## 6. Open question for production

What role does the production database connect as? If it is also a superuser,
migration 036 is inert there and merging it is risk-free. If it is a non-owner,
036 changes nothing either (those tables were already ENABLEd — see §3). If it
is the **owner but not a superuser**, 036 activates enforcement on five tables at
deploy time, and the Test Writer paths must already be converted — they are, in
PR #78, which is why that PR is safe to merge either way.
