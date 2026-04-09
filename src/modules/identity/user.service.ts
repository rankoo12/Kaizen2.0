/**
 * Spec ref: docs/spec-identity.md §6.3 — IUserService, §9 — Registration Flow
 */

import { createHash, randomBytes } from 'crypto';
import { getPool } from '../../db/pool';
import { hashPassword, verifyPassword } from './password';
import type {
  IUserService,
  IEmailService,
  RegisterParams,
  UpdateProfileParams,
  User,
  Tenant,
} from './interfaces';
import { IdentityErrors } from './interfaces';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;       // 1 hour
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateSlug(displayName: string): string {
  return displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48);
}

export class UserService implements IUserService {
  constructor(private readonly emailService: IEmailService) {}

  // ─── Registration — atomic transaction ────────────────────────────────────

  async register(params: RegisterParams): Promise<{ user: User; personalTenant: Tenant }> {
    const email = params.email.toLowerCase().trim();
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Check email uniqueness
      const { rows: existing } = await client.query(
        `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`,
        [email],
      );
      if (existing.length > 0) throw IdentityErrors.EMAIL_TAKEN();

      // 2. Hash password
      const passwordHash = await hashPassword(params.password);

      // 3. Create user
      const { rows: userRows } = await client.query<{
        id: string; created_at: Date; updated_at: Date;
      }>(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, created_at, updated_at`,
        [email, passwordHash, params.displayName],
      );
      const userRow = userRows[0];

      // 4. Generate unique tenant slug
      const baseSlug = generateSlug(params.personalTenantName ?? `${params.displayName}'s Workspace`);
      const slug = await this.uniqueSlug(client, baseSlug);
      const tenantName = params.personalTenantName ?? `${params.displayName}'s Workspace`;

      // 5. Create personal tenant
      const { rows: tenantRows } = await client.query<{
        id: string; created_at: Date; updated_at: Date;
      }>(
        `INSERT INTO tenants (name, display_name, slug, plan_tier, is_personal)
         VALUES ($1, $1, $2, 'starter', true)
         RETURNING id, created_at, updated_at`,
        [tenantName, slug],
      );
      const tenantRow = tenantRows[0];

      // 6. Create owner membership (accepted immediately — no invite needed for own tenant)
      await client.query(
        `INSERT INTO memberships (tenant_id, user_id, role, accepted_at)
         VALUES ($1, $2, 'owner', now())`,
        [tenantRow.id, userRow.id],
      );

      await client.query('COMMIT');

      // 7. Send email verification (outside transaction — failure doesn't roll back)
      const rawVerifyToken = randomBytes(32).toString('hex');
      const verifyHash = hashToken(rawVerifyToken);
      const verifyExpires = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);
      await pool.query(
        `UPDATE users SET verify_token_hash = $1 WHERE id = $2`,
        [verifyHash, userRow.id],
      );
      void this.emailService.sendEmailVerification(email, rawVerifyToken).catch(() => {
        // Email failure must never surface to the caller
      });

      const user: User = {
        id: userRow.id,
        email,
        displayName: params.displayName,
        avatarUrl: null,
        emailVerifiedAt: null,
        lastLoginAt: null,
        deletedAt: null,
        createdAt: userRow.created_at,
        updatedAt: userRow.updated_at,
      };

      const tenant: Tenant = {
        id: tenantRow.id,
        slug,
        displayName: tenantName,
        plan: 'starter',
        isPersonal: true,
        brainOptIn: false,
        suspendedAt: null,
        deletedAt: null,
        createdAt: tenantRow.created_at,
        updatedAt: tenantRow.updated_at,
      };

      // Suppress unused var warning for verifyExpires — used conceptually above
      void verifyExpires;

      return { user, personalTenant: tenant };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Profile ───────────────────────────────────────────────────────────────

  async getById(userId: string): Promise<User | null> {
    const { rows } = await getPool().query<{
      id: string; email: string; display_name: string; avatar_url: string | null;
      email_verified_at: Date | null; last_login_at: Date | null;
      deleted_at: Date | null; created_at: Date; updated_at: Date;
    }>(
      `SELECT id, email, display_name, avatar_url, email_verified_at,
              last_login_at, deleted_at, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (rows.length === 0) return null;
    return this.mapUser(rows[0]);
  }

  async updateProfile(userId: string, params: UpdateProfileParams): Promise<User> {
    const sets: string[] = ['updated_at = now()'];
    const vals: unknown[] = [];
    let i = 1;

    if (params.displayName !== undefined) { sets.push(`display_name = $${i++}`); vals.push(params.displayName); }
    if (params.avatarUrl !== undefined)   { sets.push(`avatar_url   = $${i++}`); vals.push(params.avatarUrl); }

    vals.push(userId);
    const { rows } = await getPool().query<{
      id: string; email: string; display_name: string; avatar_url: string | null;
      email_verified_at: Date | null; last_login_at: Date | null;
      deleted_at: Date | null; created_at: Date; updated_at: Date;
    }>(
      `UPDATE users SET ${sets.join(', ')}
       WHERE id = $${i} AND deleted_at IS NULL
       RETURNING id, email, display_name, avatar_url, email_verified_at,
                 last_login_at, deleted_at, created_at, updated_at`,
      vals,
    );
    if (rows.length === 0) throw IdentityErrors.NOT_FOUND('User');
    return this.mapUser(rows[0]);
  }

  // ─── Password management ───────────────────────────────────────────────────

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const { rows } = await getPool().query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (rows.length === 0) throw IdentityErrors.NOT_FOUND('User');

    const valid = await verifyPassword(currentPassword, rows[0].password_hash);
    if (!valid) throw IdentityErrors.WRONG_PASSWORD();

    const newHash = await hashPassword(newPassword);
    await getPool().query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [newHash, userId],
    );

    // Revoke all refresh tokens — forces re-login on all devices
    await getPool().query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  async requestPasswordReset(email: string): Promise<void> {
    // Always resolve — never reveal whether the email exists (prevents enumeration)
    const { rows } = await getPool().query<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email = $1 AND deleted_at IS NULL`,
      [email.toLowerCase().trim()],
    );
    if (rows.length === 0) return;

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await getPool().query(
      `UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3`,
      [tokenHash, expires, rows[0].id],
    );

    void this.emailService.sendPasswordReset(rows[0].email, rawToken).catch(() => {});
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = hashToken(token);
    const { rows } = await getPool().query<{ id: string; reset_token_expires: Date }>(
      `SELECT id, reset_token_expires
       FROM users
       WHERE reset_token_hash = $1 AND deleted_at IS NULL`,
      [tokenHash],
    );

    if (rows.length === 0 || rows[0].reset_token_expires < new Date()) {
      throw IdentityErrors.INVALID_RESET_TOKEN();
    }

    const newHash = await hashPassword(newPassword);
    await getPool().query(
      `UPDATE users
       SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL, updated_at = now()
       WHERE id = $2`,
      [newHash, rows[0].id],
    );

    // Revoke all sessions after password reset
    await getPool().query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [rows[0].id],
    );
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    const { rowCount } = await getPool().query(
      `UPDATE users
       SET email_verified_at = now(), verify_token_hash = NULL, updated_at = now()
       WHERE verify_token_hash = $1 AND deleted_at IS NULL AND email_verified_at IS NULL`,
      [tokenHash],
    );
    if (!rowCount || rowCount === 0) throw IdentityErrors.INVALID_RESET_TOKEN();
  }

  // ─── Account deletion ──────────────────────────────────────────────────────

  async delete(userId: string): Promise<void> {
    // Check if user is the sole owner of any tenant (invariant I-4)
    const { rows: soleOwned } = await getPool().query<{ id: string }>(
      `SELECT t.id
       FROM tenants t
       JOIN memberships m ON m.tenant_id = t.id AND m.user_id = $1 AND m.role = 'owner' AND m.deleted_at IS NULL
       WHERE t.deleted_at IS NULL
         AND (
           SELECT COUNT(*) FROM memberships m2
           WHERE m2.tenant_id = t.id AND m2.role = 'owner' AND m2.deleted_at IS NULL
         ) = 1`,
      [userId],
    );
    if (soleOwned.length > 0) throw IdentityErrors.SOLE_OWNER();

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE memberships SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await client.query(
        `UPDATE users SET deleted_at = now(), updated_at = now() WHERE id = $1`,
        [userId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

  private mapUser(row: {
    id: string; email: string; display_name: string; avatar_url: string | null;
    email_verified_at: Date | null; last_login_at: Date | null;
    deleted_at: Date | null; created_at: Date; updated_at: Date;
  }): User {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      emailVerifiedAt: row.email_verified_at,
      lastLoginAt: row.last_login_at,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
