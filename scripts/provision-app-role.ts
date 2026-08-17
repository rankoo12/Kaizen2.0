/**
 * Provisions (or re-grants) the unprivileged runtime role.
 *
 * Spec: docs/specs/test-writer/spec-app-entity.md §5
 * Runbook: docs/runbooks/unprivileged-runtime-role.md
 *
 * Run as an ADMIN connection, and run it again after every migration — new
 * tables are covered by ALTER DEFAULT PRIVILEGES only when the migration role
 * is the one that created them, and re-running is the cheap way to be certain.
 *
 *   DATABASE_ADMIN_URL=postgres://admin@host/db \
 *   KAIZEN_APP_DB_ROLE=kaizen_app \
 *   KAIZEN_APP_DB_PASSWORD=... \
 *   npx tsx scripts/provision-app-role.ts
 *
 * Deliberately a separate command rather than a migration: creating roles is a
 * cluster-level act with different permissions and a different blast radius
 * from schema change, and coupling them means every future deploy needs role
 * privileges it should not have.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  const appRole = process.env.KAIZEN_APP_DB_ROLE ?? 'kaizen_app';
  const appPassword = process.env.KAIZEN_APP_DB_PASSWORD;

  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL (or DATABASE_URL) must be set');
  // Never defaulted. A predictable password on the role that holds every
  // tenant's data is worse than no role at all.
  if (!appPassword) throw new Error('KAIZEN_APP_DB_PASSWORD must be set — it is never defaulted');

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows: who } = await client.query<{ current_user: string; rolsuper: boolean }>(
      `SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user`);
    const migrationRole = who[0].current_user;
    if (!who[0].rolsuper) {
      // Not fatal — an owner with CREATEROLE is enough — but worth saying,
      // because the failure otherwise appears deep inside the SQL.
      console.warn(`[provision] ${migrationRole} is not a superuser; CREATE ROLE may be refused`);
    }

    // Passed as settings rather than interpolated: the password must not end up
    // in a string this file concatenates, and settings are read back with
    // current_setting inside the script.
    await client.query(`SELECT set_config('kaizen.app_role', $1, false)`, [appRole]);
    await client.query(`SELECT set_config('kaizen.app_password', $1, false)`, [appPassword]);
    await client.query(`SELECT set_config('kaizen.migration_role', $1, false)`, [migrationRole]);

    const sql = readFileSync(
      path.resolve(__dirname, '../db/roles/app_runtime_role.sql'), 'utf8',
    )
      // psql meta-commands are not valid over the wire.
      .split('\n').filter((l) => !l.startsWith('\\')).join('\n');

    await client.query(sql);

    const { rows: check } = await client.query<{
      rolsuper: boolean; rolbypassrls: boolean; can_login: boolean;
    }>(
      `SELECT rolsuper, rolbypassrls, rolcanlogin AS can_login
         FROM pg_roles WHERE rolname = $1`, [appRole]);
    if (check.length === 0) throw new Error(`role ${appRole} was not created`);

    console.log(JSON.stringify({
      event: 'app_role_provisioned',
      role: appRole,
      migrationRole,
      superuser: check[0].rolsuper,
      bypassrls: check[0].rolbypassrls,
      canLogin: check[0].can_login,
    }));
    console.log(
      `\nNext: point DATABASE_URL at ${appRole}, keep the admin URL in DATABASE_ADMIN_URL ` +
      `for migrations, and verify before restarting anything user-facing.\n` +
      `See docs/runbooks/unprivileged-runtime-role.md`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
