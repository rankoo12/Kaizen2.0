/**
 * Spec ref: docs/spec-identity.md §4 — Platform Admin Layer, §6.5 — IPlatformAdminService
 */

import { getPool } from '../../db/pool';
import { verifyPassword } from './password';
import type {
  IPlatformAdminService,
  TenantFilters,
  TenantAdminView,
  AuditLogEntry,
  AuditLogFilters,
  Pagination,
  PaginatedResult,
} from './interfaces';
import { IdentityErrors } from './interfaces';
import type { JWTSigner } from './auth.service';

/** Impersonation token TTL — 1 hour (spec §4). */
const IMPERSONATION_TTL = 60 * 60;

export class PlatformAdminService implements IPlatformAdminService {
  constructor(private readonly jwt: JWTSigner) {}

  async login(email: string, password: string): Promise<string | null> {
    const { rows } = await getPool().query<{
      id: string; password_hash: string; display_name: string;
    }>(
      `SELECT id, password_hash, display_name
       FROM platform_admins WHERE email = $1`,
      [email.toLowerCase().trim()],
    );
    if (rows.length === 0) {
      // Dummy compare to prevent timing enumeration
      await verifyPassword(password, 'dummy:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000');
      return null;
    }
    const admin = rows[0];
    const valid = await verifyPassword(password, admin.password_hash);
    if (!valid) return null;

    return this.jwt.sign(
      { sub: admin.id, type: 'platform_admin', displayName: admin.display_name },
      { expiresIn: '8h' },
    );
  }

  async listTenants(
    filters: TenantFilters,
    pagination: Pagination,
  ): Promise<PaginatedResult<TenantAdminView>> {
    const conditions: string[] = ['t.deleted_at IS NULL'];
    const vals: unknown[] = [];
    let i = 1;

    if (filters.plan)      { conditions.push(`t.plan_tier = $${i++}`); vals.push(filters.plan); }
    if (filters.suspended === true)  { conditions.push(`t.suspended_at IS NOT NULL`); }
    if (filters.suspended === false) { conditions.push(`t.suspended_at IS NULL`); }
    if (filters.search)    { conditions.push(`t.display_name ILIKE $${i++}`); vals.push(`%${filters.search}%`); }

    const where = conditions.join(' AND ');
    const offset = (pagination.page - 1) * pagination.limit;

    const [rowsResult, countResult] = await Promise.all([
      getPool().query(
        `SELECT t.id, t.slug, t.display_name, t.plan_tier, t.is_personal,
                t.global_brain_opt_in, t.suspended_at, t.deleted_at, t.created_at, t.updated_at,
                COUNT(DISTINCT m.id)::int AS member_count,
                MAX(u.email) FILTER (WHERE m.role = 'owner') AS owner_email
         FROM tenants t
         LEFT JOIN memberships m ON m.tenant_id = t.id AND m.deleted_at IS NULL AND m.accepted_at IS NOT NULL
         LEFT JOIN users u ON u.id = m.user_id
         WHERE ${where}
         GROUP BY t.id
         ORDER BY t.created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
        [...vals, pagination.limit, offset],
      ),
      getPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM tenants t WHERE ${where}`,
        vals,
      ),
    ]);

    return {
      items: rowsResult.rows.map(this.mapTenantAdminView),
      total: parseInt(countResult.rows[0].count, 10),
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async getTenant(tenantId: string): Promise<TenantAdminView | null> {
    const { rows } = await getPool().query(
      `SELECT t.id, t.slug, t.display_name, t.plan_tier, t.is_personal,
              t.global_brain_opt_in, t.suspended_at, t.deleted_at, t.created_at, t.updated_at,
              COUNT(DISTINCT m.id)::int AS member_count,
              MAX(u.email) FILTER (WHERE m.role = 'owner') AS owner_email
       FROM tenants t
       LEFT JOIN memberships m ON m.tenant_id = t.id AND m.deleted_at IS NULL AND m.accepted_at IS NOT NULL
       LEFT JOIN users u ON u.id = m.user_id
       WHERE t.id = $1
       GROUP BY t.id`,
      [tenantId],
    );
    if (rows.length === 0) return null;
    return this.mapTenantAdminView(rows[0]);
  }

  async suspendTenant(tenantId: string, adminId: string, reason: string): Promise<void> {
    await getPool().query(
      `UPDATE tenants SET suspended_at = now(), updated_at = now() WHERE id = $1`,
      [tenantId],
    );
    await this.writeAuditLog(adminId, 'suspend_tenant', 'tenant', tenantId, { reason });
  }

  async unsuspendTenant(tenantId: string, adminId: string): Promise<void> {
    await getPool().query(
      `UPDATE tenants SET suspended_at = NULL, updated_at = now() WHERE id = $1`,
      [tenantId],
    );
    await this.writeAuditLog(adminId, 'unsuspend_tenant', 'tenant', tenantId, {});
  }

  async overridePlan(tenantId: string, adminId: string, plan: string): Promise<void> {
    // Cast through TEXT to avoid ENUM constraint — plan_tier ENUM values are: starter, growth, enterprise
    // For now update only display; plan_tier ENUM cannot store arbitrary values.
    // v1: just record the override in audit log; actual enforcement is not implemented.
    await this.writeAuditLog(adminId, 'override_plan', 'tenant', tenantId, { plan });
  }

  async impersonateUser(userId: string, adminId: string): Promise<string> {
    const { rows } = await getPool().query<{ email: string; display_name: string }>(
      `SELECT email, display_name FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (rows.length === 0) throw IdentityErrors.NOT_FOUND('User');

    // Find the user's personal tenant for the impersonation context
    const { rows: memberRows } = await getPool().query<{ tenant_id: string; role: string }>(
      `SELECT m.tenant_id, m.role
       FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 AND m.deleted_at IS NULL AND m.accepted_at IS NOT NULL
       ORDER BY t.is_personal DESC, m.created_at ASC
       LIMIT 1`,
      [userId],
    );
    if (memberRows.length === 0) throw IdentityErrors.NOT_FOUND('User membership');

    const token = this.jwt.sign(
      {
        sub: userId,
        tenantId: memberRows[0].tenant_id,
        role: memberRows[0].role,
        email: rows[0].email,
        impersonatedBy: adminId,
      },
      { expiresIn: IMPERSONATION_TTL },
    );

    await this.writeAuditLog(adminId, 'impersonate_user', 'user', userId, {
      targetEmail: rows[0].email,
      tenantId: memberRows[0].tenant_id,
    }, userId);

    return token;
  }

  async listAuditLog(
    filters: AuditLogFilters,
    pagination: Pagination,
  ): Promise<PaginatedResult<AuditLogEntry>> {
    const conditions: string[] = [];
    const vals: unknown[] = [];
    let i = 1;

    if (filters.adminId)    { conditions.push(`admin_id = $${i++}`);    vals.push(filters.adminId); }
    if (filters.targetType) { conditions.push(`target_type = $${i++}`); vals.push(filters.targetType); }
    if (filters.targetId)   { conditions.push(`target_id = $${i++}`);   vals.push(filters.targetId); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (pagination.page - 1) * pagination.limit;

    const [rowsResult, countResult] = await Promise.all([
      getPool().query(
        `SELECT id, admin_id, action, target_type, target_id, impersonated_as, metadata, created_at
         FROM platform_audit_log ${where}
         ORDER BY created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
        [...vals, pagination.limit, offset],
      ),
      getPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM platform_audit_log ${where}`,
        vals,
      ),
    ]);

    return {
      items: rowsResult.rows.map((r) => ({
        id: r.id, adminId: r.admin_id, action: r.action,
        targetType: r.target_type, targetId: r.target_id,
        impersonatedAs: r.impersonated_as, metadata: r.metadata,
        createdAt: r.created_at,
      })),
      total: parseInt(countResult.rows[0].count, 10),
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async writeAuditLog(
    adminId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
    impersonatedAs?: string,
  ): Promise<void> {
    await getPool().query(
      `INSERT INTO platform_audit_log (admin_id, action, target_type, target_id, impersonated_as, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, action, targetType, targetId, impersonatedAs ?? null, JSON.stringify(metadata)],
    );
  }

  private mapTenantAdminView(row: {
    id: string; slug: string; display_name: string; plan_tier: string;
    is_personal: boolean; global_brain_opt_in: boolean;
    suspended_at: Date | null; deleted_at: Date | null;
    created_at: Date; updated_at: Date;
    member_count: number; owner_email: string;
  }): TenantAdminView {
    return {
      id: row.id, slug: row.slug, displayName: row.display_name,
      plan: row.plan_tier, isPersonal: row.is_personal, brainOptIn: row.global_brain_opt_in,
      suspendedAt: row.suspended_at, deletedAt: row.deleted_at,
      createdAt: row.created_at, updatedAt: row.updated_at,
      memberCount: row.member_count, ownerEmail: row.owner_email,
    };
  }
}
