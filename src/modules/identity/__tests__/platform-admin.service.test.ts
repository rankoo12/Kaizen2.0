/**
 * Tests: platform-admin.service.ts
 * Spec ref: docs/spec-identity.md §4, §6.5 — IPlatformAdminService
 *
 * Every impersonation action must be audit-logged (no silent access).
 */

import { PlatformAdminService } from '../platform-admin.service';
import { hashPassword } from '../password';

// ─── Mock DB pool ─────────────────────────────────────────────────────────────

const mockQuery = jest.fn();

jest.mock('../../../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// ─── JWT stub ─────────────────────────────────────────────────────────────────

function makeJwt() {
  return {
    sign: jest.fn().mockReturnValue('admin-jwt-token'),
    verify: jest.fn(),
  };
}

function makeService() {
  return new PlatformAdminService(makeJwt());
}

let realAdminHash: string;
beforeAll(async () => {
  realAdminHash = await hashPassword('admin-pass-123');
});

beforeEach(() => jest.clearAllMocks());

// =============================================================================
// login()
// =============================================================================

describe('PlatformAdminService.login', () => {
  it('returns null when admin does not exist (runs dummy compare)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const svc = makeService();
    expect(await svc.login('unknown@kaizen.io', 'pw')).toBeNull();
  });

  it('returns null on wrong password', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', password_hash: realAdminHash, display_name: 'Admin' }] });
    const svc = makeService();
    expect(await svc.login('admin@kaizen.io', 'wrong-pass')).toBeNull();
  });

  it('returns a signed JWT string on success', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', password_hash: realAdminHash, display_name: 'Admin' }] });
    const jwt = makeJwt();
    const svc = new PlatformAdminService(jwt);
    const token = await svc.login('admin@kaizen.io', 'admin-pass-123');

    expect(token).toBe('admin-jwt-token');
    expect(jwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'a1', type: 'platform_admin' }),
      expect.objectContaining({ expiresIn: '8h' }),
    );
  });
});

// =============================================================================
// listTenants()
// =============================================================================

describe('PlatformAdminService.listTenants', () => {
  const baseRow = {
    id: 't1', slug: 'acme', display_name: 'Acme', plan_tier: 'starter',
    is_personal: false, global_brain_opt_in: false,
    suspended_at: null, deleted_at: null, created_at: new Date(), updated_at: new Date(),
    member_count: 3, owner_email: 'owner@acme.com',
  };

  it('returns paginated tenant list', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [baseRow] })        // tenants query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] }); // count query

    const result = await makeService().listTenants({}, { page: 1, limit: 10 });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].memberCount).toBe(3);
    expect(result.items[0].ownerEmail).toBe('owner@acme.com');
  });

  it('applies plan filter', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await makeService().listTenants({ plan: 'enterprise' }, { page: 1, limit: 10 });

    const [listSql] = mockQuery.mock.calls[0];
    expect(listSql).toMatch(/plan_tier/);
  });

  it('applies suspended=true filter', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await makeService().listTenants({ suspended: true }, { page: 1, limit: 10 });

    const [listSql] = mockQuery.mock.calls[0];
    expect(listSql).toMatch(/suspended_at IS NOT NULL/);
  });

  it('applies suspended=false filter', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await makeService().listTenants({ suspended: false }, { page: 1, limit: 10 });

    const [listSql] = mockQuery.mock.calls[0];
    expect(listSql).toMatch(/suspended_at IS NULL/);
  });

  it('applies search filter with ILIKE', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await makeService().listTenants({ search: 'acme' }, { page: 1, limit: 10 });

    const [listSql, params] = mockQuery.mock.calls[0];
    expect(listSql).toMatch(/ILIKE/);
    expect(params).toContain('%acme%');
  });

  it('calculates correct offset for pagination', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '50' }] });

    await makeService().listTenants({}, { page: 3, limit: 10 });

    // offset = (page - 1) * limit = 20
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain(20);
  });
});

// =============================================================================
// getTenant()
// =============================================================================

describe('PlatformAdminService.getTenant', () => {
  it('returns null when tenant not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await makeService().getTenant('nope')).toBeNull();
  });

  it('returns TenantAdminView with memberCount and ownerEmail', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 't1', slug: 's', display_name: 'T', plan_tier: 'starter',
        is_personal: false, global_brain_opt_in: false,
        suspended_at: null, deleted_at: null, created_at: now, updated_at: now,
        member_count: 5, owner_email: 'x@x.com',
      }],
    });

    const view = await makeService().getTenant('t1');
    expect(view!.memberCount).toBe(5);
    expect(view!.ownerEmail).toBe('x@x.com');
  });
});

// =============================================================================
// suspendTenant() / unsuspendTenant()
// =============================================================================

describe('PlatformAdminService.suspendTenant', () => {
  it('sets suspended_at and writes audit log', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tenants
      .mockResolvedValueOnce({ rows: [] }); // INSERT audit_log

    await makeService().suspendTenant('t1', 'admin-1', 'abuse');

    const [updateSql] = mockQuery.mock.calls[0];
    expect(updateSql).toMatch(/SET suspended_at = now/);

    const [auditSql, auditParams] = mockQuery.mock.calls[1];
    expect(auditSql).toMatch(/INSERT INTO platform_audit_log/);
    expect(auditParams[1]).toBe('suspend_tenant');
    expect(auditParams[2]).toBe('tenant');
  });
});

describe('PlatformAdminService.unsuspendTenant', () => {
  it('clears suspended_at and writes audit log', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tenants
      .mockResolvedValueOnce({ rows: [] }); // INSERT audit_log

    await makeService().unsuspendTenant('t1', 'admin-1');

    const [updateSql] = mockQuery.mock.calls[0];
    expect(updateSql).toMatch(/suspended_at = NULL/);

    const [, auditParams] = mockQuery.mock.calls[1];
    expect(auditParams[1]).toBe('unsuspend_tenant');
  });
});

// =============================================================================
// overridePlan()
// =============================================================================

describe('PlatformAdminService.overridePlan', () => {
  it('records the override in the audit log (no DB mutation in v1)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // audit INSERT

    await makeService().overridePlan('t1', 'admin-1', 'enterprise');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, auditParams] = mockQuery.mock.calls[0];
    expect(auditParams[1]).toBe('override_plan');
    // Metadata contains the plan value
    const metadata = JSON.parse(auditParams[5]);
    expect(metadata.plan).toBe('enterprise');
  });
});

// =============================================================================
// impersonateUser() — §4 Impersonation: every call must be audit-logged
// =============================================================================

describe('PlatformAdminService.impersonateUser', () => {
  it('throws NOT_FOUND when user does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().impersonateUser('bad-user', 'admin-1'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('throws NOT_FOUND when user has no membership', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: 'u@x.com', display_name: 'U' }] }) // user found
      .mockResolvedValueOnce({ rows: [] }); // no memberships

    await expect(makeService().impersonateUser('u1', 'admin-1'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('issues impersonation JWT with impersonatedBy claim (§4)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: 'u@x.com', display_name: 'User' }] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't1', role: 'member' }] })
      .mockResolvedValueOnce({ rows: [] }); // audit log

    const jwt = makeJwt();
    const svc = new PlatformAdminService(jwt);

    const token = await svc.impersonateUser('u1', 'admin-1');
    expect(token).toBe('admin-jwt-token');

    const signCall = (jwt.sign as jest.Mock).mock.calls[0];
    expect(signCall[0]).toMatchObject({
      sub: 'u1',
      impersonatedBy: 'admin-1',
      tenantId: 't1',
      role: 'member',
    });
  });

  it('impersonation token TTL is 1 hour (3600 seconds)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: 'u@x.com', display_name: 'User' }] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't1', role: 'owner' }] })
      .mockResolvedValueOnce({ rows: [] });

    const jwt = makeJwt();
    const svc = new PlatformAdminService(jwt);
    await svc.impersonateUser('u1', 'admin-1');

    const signCall = (jwt.sign as jest.Mock).mock.calls[0];
    expect(signCall[1]).toMatchObject({ expiresIn: 3600 });
  });

  it('writes audit log entry for every impersonation (no silent access)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: 'u@x.com', display_name: 'User' }] })
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't1', role: 'member' }] })
      .mockResolvedValueOnce({ rows: [] }); // audit log INSERT

    await makeService().impersonateUser('u1', 'admin-1');

    const auditCall = mockQuery.mock.calls[2];
    expect(auditCall[0]).toMatch(/INSERT INTO platform_audit_log/);
    expect(auditCall[1][1]).toBe('impersonate_user');
    expect(auditCall[1][0]).toBe('admin-1'); // adminId
    expect(auditCall[1][3]).toBe('u1');       // targetId
  });
});

// =============================================================================
// listAuditLog()
// =============================================================================

describe('PlatformAdminService.listAuditLog', () => {
  it('returns paginated audit log entries', async () => {
    const now = new Date();
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'log1', admin_id: 'a1', action: 'suspend_tenant',
          target_type: 'tenant', target_id: 't1', impersonated_as: null,
          metadata: { reason: 'abuse' }, created_at: now,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const result = await makeService().listAuditLog({}, { page: 1, limit: 10 });
    expect(result.total).toBe(1);
    expect(result.items[0].action).toBe('suspend_tenant');
    expect(result.items[0].adminId).toBe('a1');
  });

  it('applies adminId filter', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await makeService().listAuditLog({ adminId: 'a1' }, { page: 1, limit: 10 });

    const [listSql] = mockQuery.mock.calls[0];
    expect(listSql).toMatch(/admin_id/);
  });
});
