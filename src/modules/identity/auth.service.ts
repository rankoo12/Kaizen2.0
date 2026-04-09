/**
 * Spec ref: docs/spec-identity.md §6.1 — IAuthService, §8 — Auth Flow, §11 — JWT Contract
 */

import { createHash, randomBytes } from 'crypto';
import type { Redis } from 'ioredis';
import { getPool } from '../../db/pool';
import { verifyPassword } from './password';
import type {
  IAuthService,
  LoginResult,
  TokenPair,
  AccessTokenClaims,
  TenantSummary,
  MembershipRole,
} from './interfaces';

/** Session token TTL in seconds (step 1 of login flow). */
const SESSION_TOKEN_TTL = 5 * 60;

/** Refresh token TTL in days. */
const REFRESH_TOKEN_TTL_DAYS = 30;

/** Access token TTL in seconds (15 minutes). */
const ACCESS_TOKEN_TTL = 15 * 60;

function sessionKey(tokenHash: string): string {
  return `login_session:${tokenHash}`;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(32).toString('hex');
}

/** Minimal JWT interface — satisfied by @fastify/jwt's app.jwt */
export interface JWTSigner {
  sign(payload: object, options?: { expiresIn?: string | number }): string;
  verify<T = unknown>(token: string): T;
}

export class AuthService implements IAuthService {
  constructor(
    private readonly redis: Redis,
    private readonly jwt: JWTSigner,
  ) {}

  // ─── Step 1: validate credentials ─────────────────────────────────────────

  async login(email: string, password: string): Promise<LoginResult | null> {
    const { rows } = await getPool().query<{
      id: string;
      password_hash: string;
    }>(
      `SELECT id, password_hash
       FROM users
       WHERE email = $1 AND deleted_at IS NULL`,
      [email.toLowerCase().trim()],
    );

    if (rows.length === 0) {
      // Still run a hash comparison to prevent timing-based email enumeration
      await verifyPassword(password, 'dummy:0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000');
      return null;
    }

    const user = rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return null;

    // Fetch tenants the user belongs to
    const tenants = await this.getUserTenants(user.id);

    // Generate session token (single-use, stored in Redis)
    const rawSession = generateRawToken();
    const sessionHash = hashToken(rawSession);
    await this.redis.setex(sessionKey(sessionHash), SESSION_TOKEN_TTL, user.id);

    // Update last_login_at (fire-and-forget)
    void getPool().query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

    return { sessionToken: rawSession, tenants };
  }

  // ─── Step 2: exchange session token for JWT pair ───────────────────────────

  async issueToken(sessionToken: string, tenantId: string): Promise<TokenPair | null> {
    const sessionHash = hashToken(sessionToken);
    const userId = await this.redis.getdel(sessionKey(sessionHash));
    if (!userId) return null;

    return this.issueTokenDirect(userId, tenantId);
  }

  // ─── Direct issuance (used after registration) ────────────────────────────

  async issueTokenDirect(userId: string, tenantId: string): Promise<TokenPair> {
    // Verify membership exists and tenant is active
    const { rows } = await getPool().query<{
      role: MembershipRole;
      email: string;
      suspended_at: Date | null;
    }>(
      `SELECT m.role, u.email, t.suspended_at
       FROM memberships m
       JOIN users    u ON u.id = m.user_id
       JOIN tenants  t ON t.id = m.tenant_id
       WHERE m.user_id   = $1
         AND m.tenant_id = $2
         AND m.deleted_at IS NULL
         AND m.accepted_at IS NOT NULL`,
      [userId, tenantId],
    );

    if (rows.length === 0) throw new Error('No active membership for this tenant.');
    const { role, email, suspended_at } = rows[0];
    if (suspended_at) throw new Error('TENANT_SUSPENDED');

    const claims: Omit<AccessTokenClaims, 'sub'> & { sub: string } = {
      sub: userId,
      tenantId,
      role,
      email,
    };

    const accessToken = this.jwt.sign(claims, { expiresIn: ACCESS_TOKEN_TTL });
    const rawRefresh = generateRawToken();
    const refreshHash = hashToken(rawRefresh);

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await getPool().query(
      `INSERT INTO refresh_tokens (user_id, tenant_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, tenantId, refreshHash, expiresAt],
    );

    return { accessToken, refreshToken: rawRefresh, expiresIn: ACCESS_TOKEN_TTL };
  }

  // ─── Refresh token rotation ────────────────────────────────────────────────

  async refresh(refreshToken: string): Promise<TokenPair | null> {
    const tokenHash = hashToken(refreshToken);
    const { rows } = await getPool().query<{
      id: string;
      user_id: string;
      tenant_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, user_id, tenant_id, expires_at, revoked_at
       FROM refresh_tokens
       WHERE token_hash = $1`,
      [tokenHash],
    );

    if (rows.length === 0) return null;
    const token = rows[0];
    if (token.revoked_at) return null;
    if (token.expires_at < new Date()) return null;

    // Revoke old token atomically
    await getPool().query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`,
      [token.id],
    );

    return this.issueTokenDirect(token.user_id, token.tenant_id);
  }

  // ─── Logout ────────────────────────────────────────────────────────────────

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    await getPool().query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  async logoutAll(userId: string): Promise<void> {
    await getPool().query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  // ─── Token verification ────────────────────────────────────────────────────

  async verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
    try {
      const claims = this.jwt.verify<AccessTokenClaims>(token);
      if (!claims.sub || !claims.tenantId || !claims.role) return null;
      return claims;
    } catch {
      return null;
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async getUserTenants(userId: string): Promise<TenantSummary[]> {
    const { rows } = await getPool().query<{
      id: string;
      slug: string;
      display_name: string;
      is_personal: boolean;
      role: MembershipRole;
    }>(
      `SELECT t.id, t.slug, t.display_name, t.is_personal, m.role
       FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id    = $1
         AND m.deleted_at  IS NULL
         AND m.accepted_at IS NOT NULL
         AND t.deleted_at  IS NULL
       ORDER BY t.is_personal DESC, t.created_at ASC`,
      [userId],
    );

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      displayName: r.display_name,
      isPersonal: r.is_personal,
      role: r.role,
    }));
  }
}
