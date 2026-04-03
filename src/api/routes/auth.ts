import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool';
import { generateRawKey, hashKey, requireApiKey, requireScope } from '../middleware/auth';

/**
 * Spec ref: Section 19 — API Key Management
 *
 * Routes:
 *   POST /auth/keys       — issue a new API key for a tenant (admin scope required)
 *   GET  /auth/keys       — list all keys for the authenticated tenant (admin scope)
 *   DELETE /auth/keys/:id — revoke a key (admin scope)
 *
 * The raw key is returned ONCE at creation. Afterwards only the prefix is shown.
 */

const CreateKeyBody = z.object({
  scope: z.enum(['read_only', 'execute', 'admin']).default('execute'),
  description: z.string().max(255).optional(),
  expiresAt: z.string().datetime().optional(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /auth/keys — issue a new API key ─────────────────────────────────
  app.post(
    '/auth/keys',
    { preHandler: [requireApiKey, requireScope('admin')] },
    async (request, reply) => {
      const body = CreateKeyBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: body.error.issues });
      }

      const rawKey = generateRawKey();
      const keyHash = hashKey(rawKey);
      const keyPrefix = rawKey.slice(0, 12); // "kzn_live_xxx" for display
      const { scope, description, expiresAt } = body.data;

      const { rows } = await getPool().query<{ id: string; created_at: Date }>(
        `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, scope, description, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at`,
        [
          request.tenantId,
          keyHash,
          keyPrefix,
          scope,
          description ?? null,
          expiresAt ?? null,
        ],
      );

      // Return the raw key exactly once — it cannot be recovered after this response
      return reply.status(201).send({
        id: rows[0].id,
        key: rawKey,          // ← shown once only
        keyPrefix,
        scope,
        description: description ?? null,
        expiresAt: expiresAt ?? null,
        createdAt: rows[0].created_at,
      });
    },
  );

  // ── GET /auth/keys — list keys for this tenant ────────────────────────────
  app.get(
    '/auth/keys',
    { preHandler: [requireApiKey, requireScope('admin')] },
    async (request, reply) => {
      const { rows } = await getPool().query<{
        id: string;
        key_prefix: string;
        scope: string;
        description: string | null;
        expires_at: Date | null;
        last_used_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, key_prefix, scope, description, expires_at, last_used_at, created_at
         FROM api_keys
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [request.tenantId],
      );

      return reply.send({ keys: rows });
    },
  );

  // ── DELETE /auth/keys/:id — revoke a key ──────────────────────────────────
  app.delete(
    '/auth/keys/:id',
    { preHandler: [requireApiKey, requireScope('admin')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const { rowCount } = await getPool().query(
        `DELETE FROM api_keys WHERE id = $1 AND tenant_id = $2`,
        [id, request.tenantId],
      );

      if (rowCount === 0) {
        return reply.status(404).send({ error: 'Key not found' });
      }

      return reply.status(204).send();
    },
  );

  // ── POST /auth/token — exchange API key for short-lived JWT ───────────────
  // Used by web UI sessions. The Bearer API key remains valid independently.
  app.post(
    '/auth/token',
    { preHandler: [requireApiKey] },
    async (request, reply) => {
      // @fastify/jwt is registered on the app instance
      const token = (app as any).jwt.sign(
        { tenantId: request.tenantId, scope: request.keyScope },
        { expiresIn: '1h' },
      );

      return reply.send({ token, expiresIn: 3600 });
    },
  );
}
