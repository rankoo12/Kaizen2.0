import { createHash, randomBytes } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { getPool } from '../../db/pool';

/**
 * Spec ref: Section 19 — Security Model
 *
 * API key format: kzn_live_<32-random-hex>
 * Only SHA-256(key) is stored. Raw key shown once at creation.
 *
 * Auth flow:
 *   1. Extract key from `Authorization: Bearer kzn_live_xxx`
 *   2. Hash it: SHA-256(key)
 *   3. Look up api_keys table by key_hash
 *   4. Verify not expired; update last_used_at
 *   5. Set req.tenantId for downstream handlers
 *
 * JWT tokens are issued by POST /auth/token for short-lived session access.
 */

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    keyScope: 'read_only' | 'execute' | 'admin';
  }
}

export function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function generateRawKey(): string {
  return 'kzn_live_' + randomBytes(16).toString('hex');
}

/**
 * Fastify preHandler hook — validates Bearer API key, sets req.tenantId.
 * Attach to routes that require authentication.
 */
export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const rawKey = authHeader.slice(7); // strip "Bearer "

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
      `SELECT tenant_id, scope, expires_at
       FROM api_keys
       WHERE key_hash = $1
       LIMIT 1`,
      [keyHash],
    );

    if (rows.length === 0) {
      return reply.status(401).send({ error: 'Invalid API key' });
    }

    const key = rows[0];

    if (key.expires_at && key.expires_at < new Date()) {
      return reply.status(401).send({ error: 'API key has expired' });
    }

    // Fire-and-forget: update last_used_at
    void getPool().query(
      `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1`,
      [keyHash],
    );

    request.tenantId = key.tenant_id;
    request.keyScope = key.scope;
  } catch (e: any) {
    request.log.error({ event: 'auth.db_error', error: e.message });
    return reply.status(500).send({ error: 'Authentication service unavailable' });
  }
}

/**
 * Scope guard — call after requireApiKey to enforce minimum scope.
 * Usage: preHandler: [requireApiKey, requireScope('admin')]
 */
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
