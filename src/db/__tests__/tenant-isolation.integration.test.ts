import path from 'path';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { getPool, closePool } from '../pool';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Tenant isolation, proved behaviourally against a real Postgres.
 *
 * Spec: docs/specs/test-writer/spec-app-entity.md §4 (attack 2), §8
 *
 * A grep-based guard cannot prove this and neither can a mocked query: both
 * assert that we *wrote* `tenant_id = $1`, which is exactly the discipline whose
 * fallibility is the problem. The only honest test asks the database, under a
 * role with ordinary privileges, for another tenant's rows — with no predicate
 * at all — and requires that it not get them.
 *
 * The test creates its own unprivileged role rather than reusing the app's
 * connection, because what is being tested is the MECHANISM. Whether the
 * application's own role can bypass that mechanism is a separate question, and
 * it gets its own assertion below — the one that is currently the whole story.
 *
 * Excluded from the unit run (CI has no Postgres). Run against the dev stack:
 *   npm run test:integration
 */
const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const TENANT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const PROBE_ROLE = 'kaizen_rls_probe';
const PROBE_PASSWORD = 'probe-only-for-tests';

const FORCED_TABLES = [
  'site_pages', 'page_elements', 'page_links', 'app_briefs', 'generation_jobs',
] as const;

/** A connection with ordinary privileges — no ownership, no superuser. */
async function connectAsProbe(): Promise<Client> {
  const url = new URL(process.env.DATABASE_URL as string);
  const client = new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.replace(/^\//, ''),
    user: PROBE_ROLE,
    password: PROBE_PASSWORD,
  });
  await client.connect();
  return client;
}

describe('tenant isolation is enforced by the database, not by query discipline', () => {
  let suiteA: string;
  let suiteB: string;

  beforeAll(async () => {
    const pool = getPool();
    for (const [id, slug] of [[TENANT_A, 'iso-a'], [TENANT_B, 'iso-b']] as const) {
      await pool.query(
        `INSERT INTO tenants (id, name, display_name, slug, plan_tier)
         VALUES ($1, $2, $2, $2, 'starter') ON CONFLICT (id) DO NOTHING`,
        [id, slug],
      );
    }
    const mk = async (tenant: string, name: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO test_suites (tenant_id, name) VALUES ($1, $2) RETURNING id`,
        [tenant, name],
      );
      return rows[0].id;
    };
    suiteA = await mk(TENANT_A, 'iso-suite-a');
    suiteB = await mk(TENANT_B, 'iso-suite-b');

    for (const [tenant, suite, url] of [
      [TENANT_A, suiteA, 'https://iso-a.test/'],
      [TENANT_B, suiteB, 'https://iso-b.test/'],
    ] as const) {
      await pool.query(
        `INSERT INTO site_pages (tenant_id, suite_id, url_normalized, content_hash)
         VALUES ($1, $2, $3, 'iso-hash') ON CONFLICT DO NOTHING`,
        [tenant, suite, url],
      );
    }

    await pool.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
    await pool.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PASSWORD}'`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PROBE_ROLE}`);
  });

  afterAll(async () => {
    const pool = getPool();
    for (const t of [TENANT_A, TENANT_B]) {
      await pool.query(`DELETE FROM site_pages WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM test_suites WHERE tenant_id = $1`, [t]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [t]);
    }
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
    await pool.query(`REVOKE USAGE ON SCHEMA public FROM ${PROBE_ROLE}`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
    await closePool();
  });

  it('has FORCE enabled on every table migration 036 claims', async () => {
    // Without FORCE, a table's owner is exempt from its own policies — the
    // policy reads as protection while doing nothing at all.
    const { rows } = await getPool().query<{ relname: string; forced: boolean }>(
      `SELECT relname, relforcerowsecurity AS forced
         FROM pg_class WHERE relname = ANY($1::text[])`,
      [[...FORCED_TABLES]],
    );
    expect(rows).toHaveLength(FORCED_TABLES.length);
    for (const row of rows) {
      expect({ table: row.relname, forced: row.forced })
        .toEqual({ table: row.relname, forced: true });
    }
  });

  describe('under a role with ordinary privileges', () => {
    let probe: Client;
    beforeAll(async () => { probe = await connectAsProbe(); });
    afterAll(async () => { await probe.end(); });

    it('shows a tenant only its own rows, with no tenant_id predicate at all', async () => {
      // Note the SQL: no WHERE. If isolation depended on query discipline this
      // would return both tenants' pages.
      await probe.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TENANT_A]);
      const { rows } = await probe.query<{ url_normalized: string }>(
        `SELECT url_normalized FROM site_pages`);
      const urls = rows.map((r) => r.url_normalized);
      expect(urls).toContain('https://iso-a.test/');
      expect(urls).not.toContain('https://iso-b.test/');
    });

    it('returns nothing when one tenant asks for another tenant\'s rows by id', async () => {
      await probe.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TENANT_A]);
      const { rows } = await probe.query(
        `SELECT url_normalized FROM site_pages WHERE tenant_id = $1`, [TENANT_B]);
      expect(rows).toHaveLength(0);
    });

    it('refuses a write stamped with another tenant\'s id', async () => {
      // The 029 policies omit WITH CHECK, which Postgres reads as "the USING
      // expression governs writes too". If that reading were wrong, one tenant
      // could plant rows in another's account.
      await probe.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TENANT_A]);
      await expect(probe.query(
        `INSERT INTO site_pages (tenant_id, suite_id, url_normalized, content_hash)
         VALUES ($1, $2, 'https://smuggled.test/', 'iso-hash')`,
        [TENANT_B, suiteB],
      )).rejects.toThrow(/row-level security/i);

      const { rows } = await getPool().query(
        `SELECT 1 FROM site_pages WHERE url_normalized = 'https://smuggled.test/'`);
      expect(rows).toHaveLength(0);
    });

    it('fails loudly when a query forgets to set the tenant', async () => {
      // The regression that matters for the code: a query outside a tenant
      // transaction no longer silently reads across tenants — it errors. That
      // makes any remaining un-scoped path self-reporting instead of invisible.
      const bare = await connectAsProbe();
      try {
        await expect(bare.query(`SELECT url_normalized FROM site_pages LIMIT 1`))
          .rejects.toThrow(/app\.current_tenant_id|unrecognized configuration parameter/i);
      } finally {
        await bare.end();
      }
    });

    it('still lets the legitimate path read its own rows', async () => {
      // A security control that breaks the product is not a security control.
      await probe.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TENANT_B]);
      const { rows } = await probe.query<{ url_normalized: string }>(
        `SELECT url_normalized FROM site_pages WHERE tenant_id = $1`, [TENANT_B]);
      expect(rows.map((r) => r.url_normalized)).toEqual(['https://iso-b.test/']);
    });
  });

  /**
   * The assertion that is currently the whole story.
   *
   * Everything above proves the mechanism works. None of it applies to a
   * superuser or a BYPASSRLS role, which Postgres exempts from row-level
   * security unconditionally — FORCE included. The dev stack connects as the
   * `postgres`-created superuser, so on that stack the five FORCEd tables are
   * still, in practice, wide open to a query that forgets its predicate.
   *
   * This is expected to FAIL until the runtime connects as an unprivileged
   * role, and it is written to fail rather than skip because a silent skip is
   * how "we have RLS" becomes something a team believes without it being true.
   */
  it('the application\'s own role cannot bypass row-level security', async () => {
    const { rows } = await getPool().query<{
      current_user: string; is_super: boolean; bypass: boolean;
    }>(
      `SELECT current_user,
              rolsuper    AS is_super,
              rolbypassrls AS bypass
         FROM pg_roles WHERE rolname = current_user`,
    );
    const role = rows[0];
    expect({ role: role.current_user, superuser: role.is_super, bypassrls: role.bypass })
      .toEqual({ role: role.current_user, superuser: false, bypassrls: false });
  });
});
