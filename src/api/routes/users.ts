import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { UserService } from '../../modules/identity/user.service';
import { LogEmailService } from '../../modules/identity/log-email.service';
import { IdentityError } from '../../modules/identity/interfaces';

/**
 * Spec ref: docs/spec-identity.md §7 — API Contracts (Users)
 *
 * Routes:
 *   GET    /users/me           — get own profile
 *   PATCH  /users/me           — update display name / avatar
 *   POST   /users/me/password  — change password
 *   DELETE /users/me           — delete own account
 */

const UpdateProfileBody = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

const ChangePasswordBody = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8),
});

export async function usersRoutes(app: FastifyInstance): Promise<void> {
  const userService = new UserService(new LogEmailService());

  // ── GET /users/me ─────────────────────────────────────────────────────────
  app.get('/users/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = await userService.getById(request.userId);
    if (!user) return reply.status(404).send({ error: 'NOT_FOUND' });
    return reply.send({ user });
  });

  // ── PATCH /users/me ───────────────────────────────────────────────────────
  app.patch('/users/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = UpdateProfileBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    try {
      const user = await userService.updateProfile(request.userId, parsed.data);
      return reply.send({ user });
    } catch (err) {
      if (err instanceof IdentityError) {
        return reply.status(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // ── POST /users/me/password ───────────────────────────────────────────────
  app.post('/users/me/password', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = ChangePasswordBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    try {
      await userService.changePassword(
        request.userId,
        parsed.data.currentPassword,
        parsed.data.newPassword,
      );
      return reply.status(200).send({ ok: true });
    } catch (err) {
      if (err instanceof IdentityError) {
        return reply.status(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // ── DELETE /users/me ──────────────────────────────────────────────────────
  app.delete('/users/me', { preHandler: [requireAuth] }, async (request, reply) => {
    try {
      await userService.delete(request.userId);
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof IdentityError) {
        return reply.status(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
