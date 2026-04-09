import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool';
import { generateRawKey, hashKey, requireApiKey, requireScope, requireAuth } from '../middleware/auth';
import { AuthService } from '../../modules/identity/auth.service';
import { UserService } from '../../modules/identity/user.service';
import { LogEmailService } from '../../modules/identity/log-email.service';
import { SharedPoolService } from '../../modules/shared-pool/shared-pool.service';
import { PinoObservability } from '../../modules/observability/pino.observability';
import { createRedisConnection } from '../../queue';
import { IdentityError } from '../../modules/identity/interfaces';

/**
 * Spec ref: docs/spec-identity.md §7 — API Contracts (Auth), §8 — Auth Flow, §9 — Registration Flow
 *
 * Routes:
 *   POST /auth/register                  — register + create personal tenant
 *   POST /auth/login                     — step 1: validate credentials → session token + tenant list
 *   POST /auth/token                     — step 2: exchange session token + tenantId → JWT pair
 *   POST /auth/refresh                   — rotate refresh token
 *   POST /auth/logout                    — revoke current refresh token
 *   POST /auth/logout-all                — revoke all refresh tokens
 *   POST /auth/password-reset/request    — request password reset email
 *   POST /auth/password-reset/confirm    — confirm reset with token
 *   POST /auth/verify-email              — confirm email verification token
 *
 *   (Legacy API key management routes retained below)
 *   POST   /auth/keys
 *   GET    /auth/keys
 *   DELETE /auth/keys/:id
 *   POST   /auth/token (legacy — overloaded; JWT-session path takes priority when no API key)
 *   PATCH  /auth/brain-opt-in
 */

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(100),
  personalTenantName: z.string().min(1).max(100).optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string(),
});

const IssueTokenBody = z.object({
  sessionToken: z.string(),
  tenantId: z.string().uuid(),
});

const RefreshBody = z.object({
  refreshToken: z.string(),
});

const PasswordResetRequestBody = z.object({
  email: z.string().email(),
});

const PasswordResetConfirmBody = z.object({
  token: z.string(),
  newPassword: z.string().min(8),
});

const VerifyEmailBody = z.object({
  token: z.string(),
});

const CreateKeyBody = z.object({
  scope: z.enum(['read_only', 'execute', 'admin']).default('execute'),
  description: z.string().max(255).optional(),
  expiresAt: z.string().datetime().optional(),
});

const BrainOptInBody = z.object({
  optIn: z.boolean(),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const redis = createRedisConnection();
  const obs = new PinoObservability(app.log as any);
  const emailService = new LogEmailService();
  const authService = new AuthService(redis, (app as any).jwt);
  const userService = new UserService(emailService);
  const sharedPool = new SharedPoolService(redis, obs);

  // ── POST /auth/register ───────────────────────────────────────────────────
  app.post('/auth/register', async (request, reply) => {
    const parsed = RegisterBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }

    try {
      const { user, personalTenant } = await userService.register(parsed.data);
      const tokenPair = await authService.issueTokenDirect(user.id, personalTenant.id);
      return reply.status(201).send({ user, tenant: personalTenant, ...tokenPair });
    } catch (err) {
      if (err instanceof IdentityError) {
        return reply.status(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // ── POST /auth/login — step 1 ─────────────────────────────────────────────
  app.post('/auth/login', async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }

    const result = await authService.login(parsed.data.email, parsed.data.password);
    if (!result) {
      return reply.status(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    return reply.send(result);
  });

  // ── POST /auth/token — step 2 (session token → JWT pair) ─────────────────
  app.post('/auth/token', async (request, reply) => {
    // Legacy path: API key → short-lived JWT (keep working for existing CI integrations)
    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer kzn_live_')) {
      await requireApiKey(request, reply);
      if (reply.sent) return;
      const token = (app as any).jwt.sign(
        { tenantId: request.tenantId, scope: request.keyScope },
        { expiresIn: '1h' },
      );
      return reply.send({ token, expiresIn: 3600 });
    }

    // New path: session token → full JWT pair
    const parsed = IssueTokenBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }

    try {
      const tokenPair = await authService.issueToken(parsed.data.sessionToken, parsed.data.tenantId);
      if (!tokenPair) return reply.status(401).send({ error: 'INVALID_SESSION_TOKEN' });
      return reply.send(tokenPair);
    } catch (err) {
      if (err instanceof IdentityError) {
        return reply.status(err.statusCode).send({ error: err.code, message: err.message });
      }
      if (err instanceof Error && err.message === 'TENANT_SUSPENDED') {
        return reply.status(403).send({ error: 'TENANT_SUSPENDED' });
      }
      throw err;
    }
  });

  // ── POST /auth/refresh ────────────────────────────────────────────────────
  app.post('/auth/refresh', async (request, reply) => {
    const parsed = RefreshBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }

    const tokenPair = await authService.refresh(parsed.data.refreshToken);
    if (!tokenPair) return reply.status(401).send({ error: 'INVALID_REFRESH_TOKEN' });
    return reply.send(tokenPair);
  });

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  app.post('/auth/logout', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = RefreshBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    await authService.logout(parsed.data.refreshToken);
    return reply.status(204).send();
  });

  // ── POST /auth/logout-all ─────────────────────────────────────────────────
  app.post('/auth/logout-all', { preHandler: [requireAuth] }, async (request, reply) => {
    await authService.logoutAll(request.userId);
    return reply.status(204).send();
  });

  // ── POST /auth/password-reset/request ─────────────────────────────────────
  app.post('/auth/password-reset/request', async (request, reply) => {
    const parsed = PasswordResetRequestBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    await userService.requestPasswordReset(parsed.data.email);
    return reply.status(200).send({ ok: true });
  });

  // ── POST /auth/password-reset/confirm ─────────────────────────────────────
  app.post('/auth/password-reset/confirm', async (request, reply) => {
    const parsed = PasswordResetConfirmBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    try {
      await userService.resetPassword(parsed.data.token, parsed.data.newPassword);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      if (err instanceof IdentityError) {
        return reply.status(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // ── POST /auth/verify-email ───────────────────────────────────────────────
  app.post('/auth/verify-email', async (request, reply) => {
    const parsed = VerifyEmailBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'INVALID_REQUEST', details: parsed.error.issues });
    }
    try {
      await userService.verifyEmail(parsed.data.token);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      if (err instanceof IdentityError) {
        return reply.status(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Legacy: API key management (unchanged)
  // ─────────────────────────────────────────────────────────────────────────

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
      const keyPrefix = rawKey.slice(0, 18);
      const { scope, description, expiresAt } = body.data;

      const { rows } = await getPool().query<{ id: string; created_at: Date }>(
        `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, scope, description, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [request.tenantId, keyHash, keyPrefix, scope, description ?? null, expiresAt ?? null],
      );
      return reply.status(201).send({
        id: rows[0].id, key: rawKey, keyPrefix, scope,
        description: description ?? null, expiresAt: expiresAt ?? null, createdAt: rows[0].created_at,
      });
    },
  );

  app.get(
    '/auth/keys',
    { preHandler: [requireApiKey, requireScope('admin')] },
    async (request, reply) => {
      const { rows } = await getPool().query(
        `SELECT id, key_prefix, scope, description, expires_at, last_used_at, created_at
         FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [request.tenantId],
      );
      return reply.send({ keys: rows });
    },
  );

  app.delete(
    '/auth/keys/:id',
    { preHandler: [requireApiKey, requireScope('admin')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { rowCount } = await getPool().query(
        `DELETE FROM api_keys WHERE id = $1 AND tenant_id = $2`,
        [id, request.tenantId],
      );
      if (rowCount === 0) return reply.status(404).send({ error: 'Key not found' });
      return reply.status(204).send();
    },
  );

  app.patch(
    '/auth/brain-opt-in',
    { preHandler: [requireApiKey, requireScope('admin')] },
    async (request, reply) => {
      const body = BrainOptInBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: body.error.issues });
      }
      await sharedPool.setOptIn(request.tenantId, body.data.optIn);
      const { rows } = await getPool().query<{ global_brain_opt_in: boolean }>(
        `SELECT global_brain_opt_in FROM tenants WHERE id = $1`,
        [request.tenantId],
      );
      return reply.send({ tenantId: request.tenantId, globalBrainOptIn: rows[0]?.global_brain_opt_in ?? body.data.optIn });
    },
  );
}
