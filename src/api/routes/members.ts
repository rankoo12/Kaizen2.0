import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import { MembershipService } from '../../modules/identity/membership.service';
import { LogEmailService } from '../../modules/identity/log-email.service';
import { IdentityError } from '../../modules/identity/interfaces';

/**
 * Spec ref: docs/spec-identity.md §7 — API Contracts (Memberships)
 *
 * Routes:
 *   GET    /tenants/:tenantId/members                        — list members + pending invites
 *   POST   /tenants/:tenantId/invites                        — send invite
 *   DELETE /tenants/:tenantId/invites/:inviteId              — revoke invite
 *   POST   /invites/:token/accept                            — accept invite
 *   PATCH  /tenants/:tenantId/members/:membershipId/role     — change role
 *   POST   /tenants/:tenantId/ownership                      — transfer ownership
 *   DELETE /tenants/:tenantId/members/:membershipId          — remove member / leave
 */

const InviteBody = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']),
});

const ChangeRoleBody = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
});

const TransferOwnershipBody = z.object({
  newOwnerUserId: z.string().uuid(),
});

export async function membersRoutes(app: FastifyInstance): Promise<void> {
  const membershipService = new MembershipService(new LogEmailService());

  function handle(err: unknown, reply: any) {
    if (err instanceof IdentityError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    throw err;
  }

  function assertTenantContext(request: any, reply: any): boolean {
    if (request.params.tenantId !== request.tenantId) {
      reply.status(403).send({ error: 'FORBIDDEN' });
      return false;
    }
    return true;
  }

  // ── GET /tenants/:tenantId/members ────────────────────────────────────────
  app.get<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId/members',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      if (!assertTenantContext(request, reply)) return;
      const [members, invites] = await Promise.all([
        membershipService.listMembers(request.params.tenantId),
        membershipService.listPendingInvites(request.params.tenantId),
      ]);
      return reply.send({ members, pendingInvites: invites });
    },
  );

  // ── POST /tenants/:tenantId/invites ───────────────────────────────────────
  app.post<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId/invites',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      if (!assertTenantContext(request, reply)) return;
      const parsed = InviteBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
      }
      try {
        const invite = await membershipService.invite(
          request.params.tenantId,
          request.userId,
          parsed.data,
        );
        return reply.status(201).send({ invite });
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── DELETE /tenants/:tenantId/invites/:inviteId ───────────────────────────
  app.delete<{ Params: { tenantId: string; inviteId: string } }>(
    '/tenants/:tenantId/invites/:inviteId',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      if (!assertTenantContext(request, reply)) return;
      try {
        await membershipService.revokeInvite(request.params.inviteId, request.userId);
        return reply.status(204).send();
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── POST /invites/:token/accept ───────────────────────────────────────────
  // Note: no tenantId in context — JWT is required but the user may not yet be
  // a member of the target tenant. The invite token carries the tenant context.
  app.post<{ Params: { token: string } }>(
    '/invites/:token/accept',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const membership = await membershipService.acceptInvite(request.params.token, request.userId);
        return reply.status(201).send({ membership });
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── PATCH /tenants/:tenantId/members/:membershipId/role ───────────────────
  app.patch<{ Params: { tenantId: string; membershipId: string } }>(
    '/tenants/:tenantId/members/:membershipId/role',
    { preHandler: [requireAuth, requireRole('admin')] },
    async (request, reply) => {
      if (!assertTenantContext(request, reply)) return;
      const parsed = ChangeRoleBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
      }
      try {
        const membership = await membershipService.changeRole(
          request.params.membershipId,
          parsed.data.role,
          request.userId,
        );
        return reply.send({ membership });
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── POST /tenants/:tenantId/ownership ─────────────────────────────────────
  app.post<{ Params: { tenantId: string } }>(
    '/tenants/:tenantId/ownership',
    { preHandler: [requireAuth, requireRole('owner')] },
    async (request, reply) => {
      if (!assertTenantContext(request, reply)) return;
      const parsed = TransferOwnershipBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
      }
      try {
        await membershipService.transferOwnership(
          request.params.tenantId,
          parsed.data.newOwnerUserId,
          request.userId,
        );
        return reply.status(200).send({ ok: true });
      } catch (err) { return handle(err, reply); }
    },
  );

  // ── DELETE /tenants/:tenantId/members/:membershipId ───────────────────────
  app.delete<{ Params: { tenantId: string; membershipId: string } }>(
    '/tenants/:tenantId/members/:membershipId',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      if (!assertTenantContext(request, reply)) return;
      try {
        await membershipService.removeMember(request.params.membershipId, request.userId);
        return reply.status(204).send();
      } catch (err) { return handle(err, reply); }
    },
  );
}
