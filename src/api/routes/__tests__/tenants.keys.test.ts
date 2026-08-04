/**
 * API key routes — the authorization rules, which are the only real logic here.
 * Spec: docs/specs/roadmap/spec-keys-quota-authorship.md §4
 *
 * The behaviours that matter and are cheap to pin down:
 *  - an admin-scoped key needs owner; read_only / execute do not
 *  - every route refuses a tenantId that isn't the caller's own
 *  - revoking something that isn't there is 404, not a silent 204
 *
 * Whether a created key actually authenticates is proven end-to-end against the live
 * stack instead — a mocked pool cannot show that.
 */
import Fastify from 'fastify';
import { tenantsRoutes } from '../tenants';
import { TenantService } from '../../../modules/identity/tenant.service';

let currentRole = 'admin';

jest.mock('../../middleware/auth', () => ({
  requireAuth: jest.fn((request: any, _reply: any, done: any) => {
    request.tenantId = 'tenant-1';
    request.userId = 'user-1';
    request.role = currentRole;
    done();
  }),
  // The real guard reads request.role, which the mock above sets per test.
  requireRole: jest.fn(() => (request: any, reply: any, done: any) => {
    if (request.role !== 'owner' && request.role !== 'admin') {
      reply.status(403).send({ error: 'FORBIDDEN' });
      return;
    }
    done();
  }),
}));

jest.mock('../../../modules/identity/tenant.service');

describe('tenant API key routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    app.decorateRequest('tenantId', '');
    app.decorateRequest('userId', '');
    app.decorateRequest('role', '');
    await app.register(tenantsRoutes);
  });

  beforeEach(() => {
    currentRole = 'admin';
    (TenantService.prototype.listApiKeys as jest.Mock).mockResolvedValue([]);
    (TenantService.prototype.createApiKey as jest.Mock).mockResolvedValue({
      key: {
        id: 'key-1', key_prefix: 'kzn_live_abc', scope: 'execute',
        description: 'CI', created_at: new Date(), last_used_at: null, expires_at: null,
      },
      rawKey: 'kzn_live_abcdef',
    });
    (TenantService.prototype.revokeApiKey as jest.Mock).mockResolvedValue(true);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns the raw key exactly once on creation, and never a hash', async () => {
    const res = await app.inject({
      method: 'POST', url: '/tenants/tenant-1/keys',
      payload: { description: 'CI', scope: 'execute' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.rawKey).toBe('kzn_live_abcdef');
    expect(JSON.stringify(body)).not.toMatch(/hash/i);

    // Listing must never carry it back.
    const list = await app.inject({ method: 'GET', url: '/tenants/tenant-1/keys' });
    expect(JSON.parse(list.payload)).toEqual({ keys: [] });
  });

  it('lets an admin create execute and read_only keys', async () => {
    for (const scope of ['execute', 'read_only']) {
      const res = await app.inject({
        method: 'POST', url: '/tenants/tenant-1/keys', payload: { scope },
      });
      expect(res.statusCode).toBe(201);
    }
  });

  it('refuses an admin-scoped key to a non-owner', async () => {
    currentRole = 'admin';
    const res = await app.inject({
      method: 'POST', url: '/tenants/tenant-1/keys', payload: { scope: 'admin' },
    });
    // An admin key can mint more keys, so issuing one is an owner decision.
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error).toBe('OWNER_REQUIRED');
    expect(TenantService.prototype.createApiKey).not.toHaveBeenCalled();
  });

  it('allows an admin-scoped key when the caller is the owner', async () => {
    currentRole = 'owner';
    const res = await app.inject({
      method: 'POST', url: '/tenants/tenant-1/keys', payload: { scope: 'admin' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('defaults the scope to execute when none is given', async () => {
    const res = await app.inject({ method: 'POST', url: '/tenants/tenant-1/keys', payload: {} });
    expect(res.statusCode).toBe(201);
    expect(TenantService.prototype.createApiKey).toHaveBeenCalledWith(
      'tenant-1', expect.objectContaining({ scope: 'execute' }),
    );
  });

  it('refuses to touch another tenant on every route', async () => {
    const other = '/tenants/tenant-2/keys';
    const calls = [
      await app.inject({ method: 'GET', url: other }),
      await app.inject({ method: 'POST', url: other, payload: { scope: 'execute' } }),
      await app.inject({ method: 'DELETE', url: `${other}/key-1` }),
    ];
    for (const res of calls) expect(res.statusCode).toBe(403);
    expect(TenantService.prototype.createApiKey).not.toHaveBeenCalled();
    expect(TenantService.prototype.revokeApiKey).not.toHaveBeenCalled();
  });

  it('answers 404 when revoking a key that is not there', async () => {
    (TenantService.prototype.revokeApiKey as jest.Mock).mockResolvedValue(false);
    const res = await app.inject({ method: 'DELETE', url: '/tenants/tenant-1/keys/nope' });
    // Silent success would let a caller believe a key was revoked when it wasn't.
    expect(res.statusCode).toBe(404);
  });

  it('rejects an unknown scope rather than coercing it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/tenants/tenant-1/keys', payload: { scope: 'superuser' },
    });
    expect(res.statusCode).toBe(400);
  });
});
