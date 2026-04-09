/**
 * Spec ref: docs/spec-identity.md §12 — Tenant Resolution, §11 — JWT Contract
 *
 * Two authentication paths are supported:
 *
 *  1. API key  (kzn_live_*)   — CI/CD; sets tenantId + keyScope
 *  2. JWT Bearer              — web UI / user sessions; sets userId + tenantId + role
 *  3. Platform admin JWT      — sets platformAdminId
 *
 * The product layer reads ONLY from request context — it never inspects auth headers.
 */

import { createHash, randomBytes } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../../db/pool';
import type { AccessTokenClaims, MembershipRole } from '../../modules/identity/interfaces';

declare module 'fastify' {
  interface FastifyRequest {
    // ── API key auth ──────────────────────────────────────────
    tenantId: string;
    keyScope: 'read_only' | 'execute' | 'admin';

    // ── JWT user auth ─────────────────────────────────────────
    userId: string;
    role: MembershipRole;
    isImpersonation: boolean;

    // ── Platform admin JWT ────────────────────────────────────
    platformAdminId: string;
  }
}

export function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function generateRawKey(): string {
  return 'kzn_live_' + randomBytes(16).toString('hex');
}

// ─── API key middleware (existing — unchanged behaviour) ──────────────────────

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers['authorization'];

  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const rawKey = authHeader.slice(7);
  if (!rawKey.startsWith('kzn_live_')) {
    return reply.status(401).send({ error: 'Invalid API key format' });
  }

  const keyHash = hashKey(rawKey);

  try {
    const { rows } = await getPool().query<{
      tenant_id: string;
      scope: 'read_only' | 'execute' | 'admin';
      expires_at: Date | null;
    }>(
      `SELECT tenant_id, scope, expires_at FROM api_keys WHERE key_hash = $1 LIMIT 1`,
      [keyHash],
    );

    if (rows.length === 0) return reply.status(401).send({ error: 'Invalid API key' });

    const key = rows[0];
    if (key.expires_at && key.expires_at < new Date()) {
      return reply.status(401).send({ error: 'API key has expired' });
    }

    void getPool().query(`UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1`, [keyHash]);

    request.tenantId = key.tenant_id;
    request.keyScope = key.scope;
  } catch (e: any) {
    request.log.error({ event: 'auth.db_error', error: e.message });
    return reply.status(500).send({ error: 'Authentication service unavailable' });
  }
}

// ─── JWT user auth middleware ─────────────────────────────────────────────────

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers['authorization'];

  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  // Reject API keys routed to user-auth endpoints
  if (token.startsWith('kzn_live_')) {
    return reply.status(401).send({ error: 'Use a session token, not an API key, for this endpoint.' });
  }

  try {
    const claims = (request.server as any).jwt.verify(token) as AccessTokenClaims;

    if (!claims.sub || !claims.tenantId || !claims.role) {
      return reply.status(401).send({ error: 'Invalid token claims' });
    }

    // Reject platform admin tokens on user routes
    if ((claims as any).type === 'platform_admin') {
      return reply.status(403).send({ error: 'Platform admin tokens cannot access user routes.' });
    }

    request.userId   = claims.sub;
    request.tenantId = claims.tenantId;
    request.role     = claims.role;
    request.isImpersonation = !!claims.impersonatedBy;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

// ─── Platform admin middleware ────────────────────────────────────────────────

export async function requirePlatformAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers['authorization'];

  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  try {
    const claims = (request.server as any).jwt.verify(token) as { sub: string; type: string };

    if (claims.type !== 'platform_admin' || !claims.sub) {
      return reply.status(403).send({ error: 'Platform admin token required.' });
    }

    request.platformAdminId = claims.sub;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

// ─── Role guard ───────────────────────────────────────────────────────────────

/** Enforces minimum role on JWT-auth routes. Call after requireAuth. */
export function requireRole(minimum: MembershipRole) {
  const order: Record<MembershipRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

  return async function roleGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (order[request.role] < order[minimum]) {
      return reply.status(403).send({
        error: `Insufficient role. Required: ${minimum}, got: ${request.role}`,
      });
    }
  };
}

// ─── Scope guard (API key routes — unchanged) ─────────────────────────────────

export function requireScope(minimum: 'read_only' | 'execute' | 'admin') {
  const order = { read_only: 0, execute: 1, admin: 2 };

  return async function scopeGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (order[request.keyScope] < order[minimum]) {
      return reply.status(403).send({
        error: `Insufficient scope. Required: ${minimum}, got: ${request.keyScope}`,
      });
    }
  };
}
