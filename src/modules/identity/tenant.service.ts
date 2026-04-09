/**
 * Spec ref: docs/spec-identity.md §6.2 — ITenantService
 */

import { createHash, randomBytes } from 'crypto';
import { getPool } from '../../db/pool';
import type {
  ITenantService,
  CreateTenantParams,
  UpdateTenantParams,
  Tenant,
  TenantUsage,
} from './interfaces';
import { IdentityErrors } from './interfaces';

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

    const [runsResult, tokensResult, membersResult] = await Promise.all([
      getPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM runs
         WHERE tenant_id = $1 AND created_at >= $2`,
        [tenantId, monthStart],
      ),
      getPool().query<{ total: string }>(
        `SELECT COALESCE(SUM(quantity), 0) AS total FROM billing_events
         WHERE tenant_id = $1 AND event_type = 'LLM_CALL' AND created_at >= $2`,
        [tenantId, monthStart],
      ),
      getPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM memberships
         WHERE tenant_id = $1 AND deleted_at IS NULL AND accepted_at IS NOT NULL`,
        [tenantId],
      ),
    ]);

    return {
      runsThisMonth: parseInt(runsResult.rows[0].count, 10),
      llmTokensThisMonth: parseInt(tokensResult.rows[0].total, 10),
      memberCount: parseInt(membersResult.rows[0].count, 10),
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

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // Revoke all existing keys for this tenant
      await client.query(`DELETE FROM api_keys WHERE tenant_id = $1`, [tenantId]);
      // Insert new key with admin scope
      await client.query(
        `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, scope)
         VALUES ($1, $2, $3, 'admin')`,
        [tenantId, keyHash, keyPrefix],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return rawKey;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async uniqueSlug(client: { query: Function }, base: string): Promise<string> {
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
