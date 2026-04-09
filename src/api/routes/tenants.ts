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
}
