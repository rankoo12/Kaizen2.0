import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import { TenantService } from '../../modules/identity/tenant.service';
import { IdentityError } from '../../modules/identity/interfaces';

/**
 * Spec ref: docs/spec-identity.md §7 — API Contracts (Tenants)
 *
 * Routes:
 *   POST   /tenants                        — create a new team tenant
 *   GET    /tenants/:tenantId              — get tenant details
 *   PATCH  /tenants/:tenantId              — update name / slug / settings
 *   DELETE /tenants/:tenantId              — delete tenant (owner only)
 *   GET    /tenants/:tenantId/usage        — get usage stats
 *   POST   /tenants/:tenantId/api-key      — rotate API key
 */

const CreateTenantBody = z.object({
  displayName: z.string().min(1).max(100),
  slug: z.string().min(2).max(48).regex(/^[a-z0-9-]+$/).optional(),
});

const UpdateTenantBody = z.object({
  displayName: z.string().min(1).max(100).optional(),
  slug: z.string().min(2).max(48).regex(/^[a-z0-9-]+$/).optional(),
  brainOptIn: z.boolean().optional(),
});

export async function tenantsRoutes(app: FastifyInstance): Promise<void> {
  const tenantService = new TenantService();

  function handle(err: unknown, reply: any) {
    if (err instanceof IdentityError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    throw err;
  }

  // ── POST /tenants ─────────────────────────────────────────────────────────
  app.post('/tenants', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = CreateTenantBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    try {
      const tenant = await tenantService.create({
        displayName: parsed.data.displayName,
        slug: parsed.data.slug,
        ownerUserId: request.userId,
      });
      return reply.status(201).send({ tenant });
    } catch (err) { return handle(err, reply); }
  });

  // ── GET /tenants/:tenantId ────────────────────────────────────────────────
  app.get<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      // Only allow access to the tenant in the JWT context
      if (request.params.tenantId !== request.tenantId) {
        return reply.status(403).send({ error: 'FORBIDDEN' });
      }
      const tenant = await tenantService.getById(request.params.tenantId);
      if (!tenant) return reply.status(404).send({ error: 'NOT_FOUND' });
      return reply.send({ tenant });
    },
  );

  // ── PATCH /tenants/:tenantId ──────────────────────────────────────────────
  app.patch<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      if (request.params.tenantId !== request.tenantId) {
        return reply.status(403).send({ error: 'FORBIDDEN' });
      }
      const parsed = UpdateTenantBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
      }
      try {
        const tenant = await tenantService.update(request.params.tenantId, parsed.data);
        return reply.send({ tenant });
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── DELETE /tenants/:tenantId ─────────────────────────────────────────────
  app.delete<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId',
    { preHandler: [requireAuth, requireRole('owner')] },
    async (request, reply) => {
      if (request.params.tenantId !== request.tenantId) {
        return reply.status(403).send({ error: 'FORBIDDEN' });
      }
      try {
        await tenantService.delete(request.params.tenantId, request.userId);
        return reply.status(204).send();
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── GET /tenants/:tenantId/usage ──────────────────────────────────────────
  app.get<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId/usage',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      if (request.params.tenantId !== request.tenantId) {
        return reply.status(403).send({ error: 'FORBIDDEN' });
      }
      const usage = await tenantService.getUsage(request.params.tenantId);
      return reply.send({ usage });
    },
  );

  // ── GET /tenants/:tenantId/usage/history ──────────────────────────────────
  /* The 30-day "cost per run trends to zero" series — the product's central claim,
     which the Usage screen could previously only gesture at with individual recent runs.
     Computed directly rather than from a rollup table: measured at 21ms for every tenant
     and every day at current volume, against a rollup's cost of a write seam in
     worker.ts (the repo's highest-conflict file) plus a staleness class of bug.
     Spec: docs/specs/roadmap/spec-cost-history-and-case-stats.md §2 */
  app.get<{ Params: { tenantId: string }; Querystring: { days?: string } }>(
    '/tenants/:tenantId/usage/history',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      if (request.params.tenantId !== request.tenantId) {
        return reply.status(403).send({ error: 'FORBIDDEN' });
      }
      const days = Math.min(90, Math.max(1, parseInt(request.query.days ?? '30', 10) || 30));
      const series = await tenantService.getUsageHistory(request.params.tenantId, days);
      return reply.send({ days, series });
    },
  );

  // ── POST /tenants/:tenantId/api-key ───────────────────────────────────────
  app.post<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId/api-key',
    { preHandler: [requireAuth, requireRole('owner')] },
    async (request, reply) => {
      if (request.params.tenantId !== request.tenantId) {
        return reply.status(403).send({ error: 'FORBIDDEN' });
      }
      try {
        const rawKey = await tenantService.rotateApiKey(request.params.tenantId, request.userId);
        return reply.status(201).send({ key: rawKey });
      } catch (err) { return handle(err, reply); }
    },
  );

  /* ── API keys ───────────────────────────────────────────────────────────────
     The /api-key route above is the legacy single-key path: it wipes every key the
     tenant holds and always mints `admin`. These replace it with independent, scoped,
     individually revocable keys. It stays reachable so existing callers keep working.
     Spec: docs/specs/roadmap/spec-keys-quota-authorship.md §4 */

  /** The raw key is unrecoverable after creation — only its SHA-256 hash is stored. */
  const toKeySummary = (k: {
    id: string; key_prefix: string; scope: string; description: string | null;
    created_at: Date; last_used_at: Date | null; expires_at: Date | null;
  }) => ({
    id: k.id,
    keyPrefix: k.key_prefix,
    scope: k.scope,
    description: k.description,
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    expiresAt: k.expires_at,
  });

  const CreateKeyBody = z.object({
    description: z.string().min(1).max(120).optional(),
    scope: z.enum(['read_only', 'execute', 'admin']).default('execute'),
    // Accepts a date or a datetime; stored as-is and enforced by requireApiKey.
    expiresAt: z.string().datetime().optional(),
  });

  // ── GET /tenants/:tenantId/keys ───────────────────────────────────────────
  app.get<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId/keys',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      if (request.params.tenantId !== request.tenantId) {
        return reply.status(403).send({ error: 'FORBIDDEN' });
      }
      const keys = await tenantService.listApiKeys(request.params.tenantId);
      return reply.send({ keys: keys.map(toKeySummary) });
    },
  );

  // ── POST /tenants/:tenantId/keys ──────────────────────────────────────────
  app.post<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId/keys',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      if (request.params.tenantId !== request.tenantId) {
        return reply.status(403).send({ error: 'FORBIDDEN' });
      }
      const parsed = CreateKeyBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
      }
      // An admin-scoped key can do everything the admin API can, including minting more
      // keys — so it takes an owner to create one. Admins can still issue read_only and
      // execute keys, which is what CI actually needs.
      if (parsed.data.scope === 'admin' && request.role !== 'owner') {
        return reply.status(403).send({
          error: 'OWNER_REQUIRED',
          message: 'Only the workspace owner can create an admin-scoped key.',
        });
      }
      const { key, rawKey } = await tenantService.createApiKey(request.params.tenantId, {
        description: parsed.data.description ?? null,
        scope: parsed.data.scope,
        expiresAt: parsed.data.expiresAt ?? null,
      });
      // rawKey appears in this response and nowhere else, ever.
      return reply.status(201).send({ key: toKeySummary(key), rawKey });
    },
  );

  // ── DELETE /tenants/:tenantId/keys/:keyId ─────────────────────────────────
  app.delete<{ Params: { tenantId: string; keyId: string } }>(
    '/tenants/:tenantId/keys/:keyId',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      if (request.params.tenantId !== request.tenantId) {
        return reply.status(403).send({ error: 'FORBIDDEN' });
      }
      const removed = await tenantService.revokeApiKey(request.params.tenantId, request.params.keyId);
      if (!removed) return reply.status(404).send({ error: 'NOT_FOUND' });
      return reply.status(204).send();
    },
  );
}
