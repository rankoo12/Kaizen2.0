/**
 * Create a test suite for a user's personal tenant, by email.
 * PowerShell:
 *   $env:PROD_DATABASE_URL="..."; npx tsx scripts/create-suite.ts user@example.com "My Suite"
 */
import { Client } from 'pg';

const url = process.env.PROD_DATABASE_URL;
const email = process.argv[2];
const name = process.argv[3] ?? 'My First Suite';

if (!url) { console.error('Set PROD_DATABASE_URL first.'); process.exit(1); }
if (!email) { console.error('Usage: create-suite.ts <email> [suiteName]'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();

  const { rows: tRows } = await c.query<{ tenant_id: string; tenant_name: string }>(
    `SELECT t.id AS tenant_id, t.display_name AS tenant_name
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.role = 'owner' AND m.deleted_at IS NULL
       JOIN tenants t ON t.id = m.tenant_id AND t.is_personal = true AND t.deleted_at IS NULL
      WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL`,
    [email],
  );
  if (tRows.length === 0) { console.error(`No personal tenant for ${email}. Register the user first.`); await c.end(); process.exit(1); }
  if (tRows.length > 1) { console.error(`Ambiguous: ${tRows.length} personal tenants for ${email}.`); await c.end(); process.exit(1); }

  const { tenant_id, tenant_name } = tRows[0];
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO test_suites (tenant_id, name, description, tags)
     VALUES ($1, $2, NULL, '{}') RETURNING id`,
    [tenant_id, name],
  );
  console.log(`✓ Created suite "${name}" (${rows[0].id}) in tenant "${tenant_name}" for ${email}.`);
  await c.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
