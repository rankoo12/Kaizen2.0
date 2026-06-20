/**
 * Grant a monthly LLM token budget to a user's personal tenant, by email.
 * PowerShell:
 *   $env:PROD_DATABASE_URL="..."; npx tsx scripts/grant-tokens.ts user@example.com 1000000
 *
 * Defaults to 1,000,000 tokens if no amount is given. Read-only preview of the
 * target tenant first; only updates after it prints what it found.
 */
import { Client } from 'pg';

const url = process.env.PROD_DATABASE_URL;
const email = process.argv[2];
const amount = Number(process.argv[3] ?? 1_000_000);

if (!url) { console.error('Set PROD_DATABASE_URL first.'); process.exit(1); }
if (!email) { console.error('Usage: grant-tokens.ts <email> [tokenAmount]'); process.exit(1); }
if (!Number.isFinite(amount) || amount < 0) { console.error('Invalid token amount.'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();

  // Find the user's OWNED personal tenant (the workspace created at registration).
  const { rows } = await c.query<{ tenant_id: string; tenant_name: string; budget: string }>(
    `SELECT t.id AS tenant_id, t.display_name AS tenant_name, t.llm_budget_tokens_monthly::text AS budget
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.role = 'owner' AND m.deleted_at IS NULL
       JOIN tenants t ON t.id = m.tenant_id AND t.is_personal = true AND t.deleted_at IS NULL
      WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL`,
    [email],
  );

  if (rows.length === 0) { console.error(`No personal tenant found for ${email}. Register the user first.`); await c.end(); process.exit(1); }
  if (rows.length > 1) { console.error(`Ambiguous: ${rows.length} owned personal tenants for ${email}. Aborting.`); await c.end(); process.exit(1); }

  const t = rows[0];
  console.log(`User ${email} → tenant "${t.tenant_name}" (${t.tenant_id})`);
  console.log(`  current budget: ${Number(t.budget).toLocaleString()} → new: ${amount.toLocaleString()}`);

  await c.query(`UPDATE tenants SET llm_budget_tokens_monthly = $1 WHERE id = $2`, [amount, t.tenant_id]);
  console.log('  ✓ updated.');
  await c.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
