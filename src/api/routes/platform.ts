import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformAdmin } from '../middleware/auth';
import { PlatformAdminService } from '../../modules/identity/platform-admin.service';
import { IdentityError } from '../../modules/identity/interfaces';

/**
 * Spec ref: docs/spec-identity.md §7 — API Contracts (Platform Admin), §4 — Platform Admin Layer
 *
 * Routes:
 *   POST   /platform/auth/login                       — platform admin login
 *   GET    /platform/tenants                          — list all tenants
 *   GET    /platform/tenants/:tenantId                — get tenant detail
 *   POST   /platform/tenants/:tenantId/suspend        — suspend tenant
 *   POST   /platform/tenants/:tenantId/unsuspend      — unsuspend tenant
 *   PATCH  /platform/tenants/:tenantId/plan           — override plan label
 *   POST   /platform/users/:userId/impersonate        — issue impersonation token
 *   GET    /platform/audit-log                        — platform audit log
 */

const PlatformLoginBody = z.object({
  email: z.string().email(),
  password: z.string(),
});

const SuspendBody = z.object({
  reason: z.string().min(1).max(500),
});

const OverridePlanBody = z.object({
  plan: z.string().min(1),
});

const PaginationQuery = z.object({
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const TenantFiltersQuery = z.object({
  plan:      z.string().optional(),
  suspended: z.enum(['true', 'false']).optional(),
  search:    z.string().optional(),
});

const AuditLogFiltersQuery = z.object({
  adminId:    z.string().uuid().optional(),
  targetType: z.string().optional(),
  targetId:   z.string().uuid().optional(),
});

export async function platformRoutes(app: FastifyInstance): Promise<void> {
  const platformAdminService = new PlatformAdminService((app as any).jwt);

  function handle(err: unknown, reply: any) {
    if (err instanceof IdentityError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    throw err;
  }

  // ── POST /platform/auth/login ─────────────────────────────────────────────
  app.post('/platform/auth/login', async (request, reply) => {
    const parsed = PlatformLoginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    const token = await platformAdminService.login(parsed.data.email, parsed.data.password);
    if (!token) return reply.status(401).send({ error: 'INVALID_CREDENTIALS' });
    return reply.send({ token });
  });

  // ── GET /platform/tenants ─────────────────────────────────────────────────
  app.get(
    '/platform/tenants',
    { preHandler: [requirePlatformAdmin] },
    async (request, reply) => {
      const filtersRaw = TenantFiltersQuery.safeParse(request.query);
      const paginationRaw = PaginationQuery.safeParse(request.query);
      if (!filtersRaw.success || !paginationRaw.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST' });
      }
      const { plan, suspended, search } = filtersRaw.data;
      const result = await platformAdminService.listTenants(
        {
          plan,
          suspended: suspended === 'true' ? true : suspended === 'false' ? false : undefined,
          search,
        },
        paginationRaw.data,
      );
      return reply.send(result);
    },
  );

  // ── GET /platform/tenants/:tenantId ───────────────────────────────────────
  app.get<{ Params: { tenantId: string } }>(
    '/platform/tenants/:tenantId',
    { preHandler: [requirePlatformAdmin] },
    async (request, reply) => {
      const tenant = await platformAdminService.getTenant(request.params.tenantId);
      if (!tenant) return reply.status(404).send({ error: 'NOT_FOUND' });
      return reply.send({ tenant });
    },
  );

  // ── POST /platform/tenants/:tenantId/suspend ──────────────────────────────
  app.post<{ Params: { tenantId: string } }>(
    '/platform/tenants/:tenantId/suspend',
    { preHandler: [requirePlatformAdmin] },
    async (request, reply) => {
      const parsed = SuspendBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
      }
      try {
        await platformAdminService.suspendTenant(
          request.params.tenantId,
          request.platformAdminId,
          parsed.data.reason,
        );
        return reply.status(200).send({ ok: true });
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── POST /platform/tenants/:tenantId/unsuspend ────────────────────────────
  app.post<{ Params: { tenantId: string } }>(
    '/platform/tenants/:tenantId/unsuspend',
    { preHandler: [requirePlatformAdmin] },
    async (request, reply) => {
      try {
        await platformAdminService.unsuspendTenant(
          request.params.tenantId,
          request.platformAdminId,
        );
        return reply.status(200).send({ ok: true });
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── PATCH /platform/tenants/:tenantId/plan ────────────────────────────────
  app.patch<{ Params: { tenantId: string } }>(
    '/platform/tenants/:tenantId/plan',
    { preHandler: [requirePlatformAdmin] },
    async (request, reply) => {
      const parsed = OverridePlanBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
      }
      try {
        await platformAdminService.overridePlan(
          request.params.tenantId,
          request.platformAdminId,
          parsed.data.plan,
        );
        return reply.status(200).send({ ok: true });
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── POST /platform/users/:userId/impersonate ──────────────────────────────
  app.post<{ Params: { userId: string } }>(
    '/platform/users/:userId/impersonate',
    { preHandler: [requirePlatformAdmin] },
    async (request, reply) => {
      try {
        const token = await platformAdminService.impersonateUser(
          request.params.userId,
          request.platformAdminId,
        );
        return reply.send({ token, expiresIn: 3600, note: 'Impersonation token — 1 hour, non-renewable.' });
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── GET /platform/audit-log ───────────────────────────────────────────────
  app.get(
    '/platform/audit-log',
    { preHandler: [requirePlatformAdmin] },
    async (request, reply) => {
      const filtersRaw = AuditLogFiltersQuery.safeParse(request.query);
      const paginationRaw = PaginationQuery.safeParse(request.query);
      if (!filtersRaw.success || !paginationRaw.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST' });
      }
      const result = await platformAdminService.listAuditLog(filtersRaw.data, paginationRaw.data);
      return reply.send(result);
    },
  );
}
