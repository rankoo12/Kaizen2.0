/**
 * Spec ref: docs/spec-identity.md §6.2 — ITenantService
 */

import { createHash, randomBytes } from 'crypto';
import { getPool } from '../../db/pool';
import { tenantPool, tenantQuery, withTenantTransaction } from '../../db/transaction';
import type {
  ITenantService,
  CreateTenantParams,
  UpdateTenantParams,
  Tenant,
  TenantUsage,
  UsageHistoryPoint,
} from './interfaces';
import { IdentityErrors } from './interfaces';
import type { KeyScope } from '../../types';

function generateSlug(displayName: string): string {
  return displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48);
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Must stay in sync with `requireApiKey`, which rejects anything not starting kzn_live_. */
function generateRawKey(): string {
  return 'kzn_live_' + randomBytes(16).toString('hex');
}

/** An api_keys row as it leaves the database. Never carries key_hash. */
export type ApiKeyRow = {
  id: string;
  key_prefix: string;
  scope: KeyScope;
  description: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
};

export class TenantService implements ITenantService {
  async create(params: CreateTenantParams): Promise<Tenant> {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const base = params.slug ?? generateSlug(params.displayName);
      const slug = await this.uniqueSlug(client, base);

      const { rows } = await client.query<{
        id: string; created_at: Date; updated_at: Date;
      }>(
        `INSERT INTO tenants (name, display_name, slug, plan_tier, is_personal)
         VALUES ($1, $1, $2, 'starter', $3)
         RETURNING id, created_at, updated_at`,
        [params.displayName, slug, params.isPersonal ?? false],
      );
      const tenantRow = rows[0];

      await client.query(
        `INSERT INTO memberships (tenant_id, user_id, role, accepted_at)
         VALUES ($1, $2, 'owner', now())`,
        [tenantRow.id, params.ownerUserId],
      );

      await client.query('COMMIT');

      return {
        id: tenantRow.id,
        slug,
        displayName: params.displayName,
        plan: 'starter',
        isPersonal: params.isPersonal ?? false,
        brainOptIn: false,
        suspendedAt: null,
        deletedAt: null,
        createdAt: tenantRow.created_at,
        updatedAt: tenantRow.updated_at,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getById(tenantId: string): Promise<Tenant | null> {
    const { rows } = await getPool().query(
      `SELECT id, slug, display_name, plan_tier, is_personal, global_brain_opt_in,
              suspended_at, deleted_at, created_at, updated_at
       FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) return null;
    return this.mapTenant(rows[0]);
  }

  async getBySlug(slug: string): Promise<Tenant | null> {
    const { rows } = await getPool().query(
      `SELECT id, slug, display_name, plan_tier, is_personal, global_brain_opt_in,
              suspended_at, deleted_at, created_at, updated_at
       FROM tenants WHERE slug = $1 AND deleted_at IS NULL`,
      [slug],
    );
    if (rows.length === 0) return null;
    return this.mapTenant(rows[0]);
  }

  async update(tenantId: string, params: UpdateTenantParams): Promise<Tenant> {
    const sets: string[] = ['updated_at = now()'];
    const vals: unknown[] = [];
    let i = 1;

    if (params.displayName !== undefined) { sets.push(`display_name = $${i++}`, `name = $${i - 1}`); vals.push(params.displayName); }
    if (params.slug !== undefined)        { sets.push(`slug = $${i++}`);          vals.push(params.slug); }
    if (params.brainOptIn !== undefined)  { sets.push(`global_brain_opt_in = $${i++}`); vals.push(params.brainOptIn); }

    vals.push(tenantId);
    const { rows } = await getPool().query(
      `UPDATE tenants SET ${sets.join(', ')}
       WHERE id = $${i} AND deleted_at IS NULL
       RETURNING id, slug, display_name, plan_tier, is_personal, global_brain_opt_in,
                 suspended_at, deleted_at, created_at, updated_at`,
      vals,
    );
    if (rows.length === 0) throw IdentityErrors.NOT_FOUND('Tenant');
    return this.mapTenant(rows[0]);
  }

  async delete(tenantId: string, requestingUserId: string): Promise<void> {
    // Verify the caller is the owner
    const { rows: ownerCheck } = await getPool().query(
      `SELECT 1 FROM memberships
       WHERE tenant_id = $1 AND user_id = $2 AND role = 'owner' AND deleted_at IS NULL`,
      [tenantId, requestingUserId],
    );
    if (ownerCheck.length === 0) throw IdentityErrors.NOT_FOUND('Tenant');

    // Invariant I-10: check if any member would be left with zero active memberships
    const { rows: orphaned } = await getPool().query<{ email: string }>(
      `SELECT u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id  = $1
         AND m.deleted_at IS NULL
         AND u.deleted_at IS NULL
         AND (
           SELECT COUNT(*)
           FROM memberships m2
           WHERE m2.user_id    = m.user_id
             AND m2.tenant_id != $1
             AND m2.deleted_at IS NULL
             AND m2.accepted_at IS NOT NULL
         ) = 0`,
      [tenantId],
    );
    if (orphaned.length > 0) {
      throw IdentityErrors.SOLE_MEMBERLESS_USER(orphaned.map((r) => r.email));
    }

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE memberships SET deleted_at = now() WHERE tenant_id = $1 AND deleted_at IS NULL`,
        [tenantId],
      );
      await client.query(
        `UPDATE tenants SET deleted_at = now(), updated_at = now() WHERE id = $1`,
        [tenantId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getUsage(tenantId: string): Promise<TenantUsage> {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // The cycle is a CALENDAR month, and it has to stay that way: usageThisMonth — the
    // function that actually rejects a run at 402 — uses the same boundary. A meter that
    // resets on a different day than enforcement would be worse than no meter.
    // Spec: docs/specs/roadmap/spec-keys-quota-authorship.md §5
    const cycleEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const db = tenantPool(tenantId);
    const [runsResult, tokensResult, membersResult, budgetResult] = await Promise.all([
      db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM runs
         WHERE tenant_id = $1 AND created_at >= $2`,
        [tenantId, monthStart],
      ),
      db.query<{ total: string }>(
        `SELECT COALESCE(SUM(quantity), 0) AS total FROM billing_events
         WHERE tenant_id = $1 AND event_type = 'LLM_CALL' AND created_at >= $2`,
        [tenantId, monthStart],
      ),
      db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM memberships
         WHERE tenant_id = $1 AND deleted_at IS NULL AND accepted_at IS NOT NULL`,
        [tenantId],
      ),
      db.query<{ llm_budget_tokens_monthly: string }>(
        `SELECT llm_budget_tokens_monthly FROM tenants WHERE id = $1`,
        [tenantId],
      ),
    ]);

    return {
      runsThisMonth: parseInt(runsResult.rows[0].count, 10),
      llmTokensThisMonth: parseInt(tokensResult.rows[0].total, 10),
      memberCount: parseInt(membersResult.rows[0].count, 10),
      // The denominator the Usage meter was missing. 0 is a real, distinct state —
      // migration 019 made it the default for new tenants — and produces a different
      // 402 (INSUFFICIENT_TOKENS) than being over an allowance (TOKEN_LIMIT_REACHED),
      // so the UI must not collapse the two.
      budgetTokensMonthly: Number(budgetResult.rows[0]?.llm_budget_tokens_monthly ?? 0),
      cycleStart: monthStart.toISOString(),
      cycleEnd: cycleEnd.toISOString(),
    };
  }

  async rotateApiKey(tenantId: string, requestingUserId: string): Promise<string> {
    // Verify caller is owner or admin
    const { rows } = await getPool().query(
      `SELECT 1 FROM memberships
       WHERE tenant_id = $1 AND user_id = $2 AND role IN ('owner', 'admin') AND deleted_at IS NULL`,
      [tenantId, requestingUserId],
    );
    if (rows.length === 0) throw IdentityErrors.NOT_FOUND('Tenant');

    const rawKey = 'kzn_live_' + randomBytes(16).toString('hex');
    const keyHash = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 18);

    // The whole rotation runs as the tenant: api_keys is under row-level
    // security, so a bare-pool transaction could neither delete the old keys
    // nor insert the new one under an unprivileged runtime.
    await withTenantTransaction(tenantId, async (client) => {
      // Revoke all existing keys for this tenant
      await client.query(`DELETE FROM api_keys WHERE tenant_id = $1`, [tenantId]);
      // Insert new key with admin scope
      await client.query(
        `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, scope)
         VALUES ($1, $2, $3, 'admin')`,
        [tenantId, keyHash, keyPrefix],
      );
    });

    return rawKey;
  }

  /**
   * Daily runs / tokens / cache-hits over the last `days` days.
   *
   * generate_series supplies the calendar so quiet days come back as zeros instead of
   * being absent. A chart that drops empty days compresses time and makes a downward
   * cost trend look steeper than it is — which, on a screen whose whole purpose is to
   * evidence that trend, would be flattering rather than true.
   *
   * Spec: docs/specs/roadmap/spec-cost-history-and-case-stats.md §4.1
   */
  async getUsageHistory(tenantId: string, days: number): Promise<UsageHistoryPoint[]> {
    const { rows } = await tenantQuery<{
      day: string; runs: string; tokens: string;
      lookups: string; cache_hits: string; heals: string; failures: string;
    }>(
      tenantId,
      `WITH calendar AS (
         SELECT generate_series(
                  (current_date - ($2::int - 1) * INTERVAL '1 day')::date,
                  current_date,
                  INTERVAL '1 day'
                )::date AS day
       ),
       run_days AS (
         SELECT r.id, r.status, r.created_at::date AS day
           FROM runs r
          WHERE r.tenant_id = $1
            AND r.created_at >= current_date - ($2::int - 1) * INTERVAL '1 day'
       ),
       -- One pass over this window's step results, keyed back to the run's day.
       -- cache_hit is deliberately unused: it is a dead column, never written
       -- (0 of 13,198 rows), so resolution_source is the only honest signal for
       -- "did this need the model".
       step_days AS (
         SELECT rd.day,
                COALESCE(SUM(sr.tokens_used), 0)                                   AS tokens,
                COUNT(*) FILTER (WHERE sr.resolution_source IS NOT NULL)           AS lookups,
                COUNT(*) FILTER (WHERE sr.resolution_source IS NOT NULL
                                   AND sr.resolution_source <> 'llm')              AS cache_hits
           FROM run_days rd
           JOIN step_results sr ON sr.run_id = rd.id
          GROUP BY rd.day
       )
       SELECT c.day::text                                                AS day,
              COALESCE(rc.runs, 0)::text                                 AS runs,
              COALESCE(sd.tokens, 0)::text                               AS tokens,
              COALESCE(sd.lookups, 0)::text                              AS lookups,
              COALESCE(sd.cache_hits, 0)::text                           AS cache_hits,
              COALESCE(rc.heals, 0)::text                                AS heals,
              COALESCE(rc.failures, 0)::text                             AS failures
         FROM calendar c
         LEFT JOIN (
           SELECT day,
                  COUNT(*)                                       AS runs,
                  COUNT(*) FILTER (WHERE status = 'healed')      AS heals,
                  COUNT(*) FILTER (WHERE status = 'failed')      AS failures
             FROM run_days GROUP BY day
         ) rc ON rc.day = c.day
         LEFT JOIN step_days sd ON sd.day = c.day
        ORDER BY c.day ASC`,
      [tenantId, days],
    );

    return rows.map((r) => ({
      day: r.day,
      runs: Number(r.runs),
      tokens: Number(r.tokens),
      lookups: Number(r.lookups),
      cacheHits: Number(r.cache_hits),
      heals: Number(r.heals),
      failures: Number(r.failures),
    }));
  }

  /* ─── API keys ───────────────────────────────────────────────────────────────
     rotateApiKey above is the legacy single-key path: it deletes every key the tenant
     has and mints one with `admin` scope. That silently breaks every other pipeline on
     rotation, and gives no way to hold a read_only or execute key. These three replace
     it — keys are independent, scoped, labelled and individually revocable.
     Spec: docs/specs/roadmap/spec-keys-quota-authorship.md §4 */

  async listApiKeys(tenantId: string): Promise<ApiKeyRow[]> {
    // key_hash is deliberately not selected: nothing outside authentication needs it,
    // and a hash that never leaves the database cannot leak through a log or a response.
    const { rows } = await tenantQuery<ApiKeyRow>(
      tenantId,
      `SELECT id, key_prefix, scope, description, created_at, last_used_at, expires_at
         FROM api_keys
        WHERE tenant_id = $1
        ORDER BY created_at DESC`,
      [tenantId],
    );
    return rows;
  }

  async createApiKey(
    tenantId: string,
    input: { description?: string | null; scope: KeyScope; expiresAt?: string | null },
  ): Promise<{ key: ApiKeyRow; rawKey: string }> {
    const rawKey = generateRawKey();
    // 'kzn_live_' is 9 chars, so this keeps 9 of the 32 random hex chars — enough for a
    // human to tell two keys apart in a list, far too little to reconstruct one.
    const keyPrefix = rawKey.slice(0, 18);

    const { rows } = await tenantQuery<ApiKeyRow>(
      tenantId,
      `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, scope, description, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, key_prefix, scope, description, created_at, last_used_at, expires_at`,
      [tenantId, hashKey(rawKey), keyPrefix, input.scope, input.description ?? null, input.expiresAt ?? null],
    );

    // The caller sees the raw key exactly once — only its hash is stored.
    return { key: rows[0], rawKey };
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
    // tenant_id in the WHERE, not just the id: without it any admin could revoke any
    // other workspace's key by guessing a uuid.
    const { rowCount } = await tenantQuery(
      tenantId,
      `DELETE FROM api_keys WHERE id = $1 AND tenant_id = $2`,
      [keyId, tenantId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async uniqueSlug(
    client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
    base: string,
  ): Promise<string> {
    let slug = base;
    let attempt = 1;
    for (;;) {
      const { rows } = await client.query(
        `SELECT 1 FROM tenants WHERE slug = $1 AND deleted_at IS NULL`,
        [slug],
      );
      if (rows.length === 0) return slug;
      slug = `${base}-${++attempt}`;
    }
  }

  private mapTenant(row: {
    id: string; slug: string; display_name: string; plan_tier: string;
    is_personal: boolean; global_brain_opt_in: boolean;
    suspended_at: Date | null; deleted_at: Date | null;
    created_at: Date; updated_at: Date;
  }): Tenant {
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      plan: row.plan_tier,
      isPersonal: row.is_personal,
      brainOptIn: row.global_brain_opt_in,
      suspendedAt: row.suspended_at,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
