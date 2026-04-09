/**
 * Tests: tenant.service.ts
 * Spec ref: docs/spec-identity.md §6.2
 *
 * Invariants covered:
 *  I-10: Tenant cannot be deleted if any member would be left with zero active memberships
 */

import { TenantService } from '../tenant.service';
import { IdentityError } from '../interfaces';

// ─── Mock DB pool ─────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockConnect = jest.fn();

jest.mock('../../../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: mockConnect }),
}));

function makeService() {
  return new TenantService();
}

beforeEach(() => jest.clearAllMocks());

// =============================================================================
// create()
// =============================================================================

describe('TenantService.create', () => {
  function makeCreateClient() {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // slug uniqueness check
      .mockResolvedValueOnce({ rows: [{ id: 't-new', created_at: new Date(), updated_at: new Date() }] }) // INSERT tenants
      .mockResolvedValueOnce({ rows: [] }) // INSERT memberships
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    return client;
  }

  it('creates tenant and owner membership in one transaction', async () => {
    const client = makeCreateClient();
    mockConnect.mockResolvedValue(client);

    const tenant = await makeService().create({
      displayName: 'Acme Corp',
      ownerUserId: 'u1',
    });

    expect(tenant.id).toBe('t-new');
    expect(tenant.displayName).toBe('Acme Corp');
    expect(tenant.isPersonal).toBe(false);

    const membershipInsert = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO memberships'),
    );
    expect(membershipInsert).toBeDefined();
    // 'owner' is hardcoded in the SQL, not passed as a parameter
    expect(membershipInsert![0]).toContain("'owner'");
  });

  it('auto-generates slug from displayName when slug is not provided', async () => {
    const client = makeCreateClient();
    mockConnect.mockResolvedValue(client);

    await makeService().create({ displayName: 'My Company!', ownerUserId: 'u1' });

    const slugCheck = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('SELECT 1 FROM tenants WHERE slug'),
    );
    expect(slugCheck![1][0]).toBe('my-company');
  });

  it('respects provided slug', async () => {
    const client = makeCreateClient();
    mockConnect.mockResolvedValue(client);

    await makeService().create({ displayName: 'Acme', ownerUserId: 'u1', slug: 'custom-slug' });

    const slugCheck = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('SELECT 1 FROM tenants WHERE slug'),
    );
    expect(slugCheck![1][0]).toBe('custom-slug');
  });

  it('creates personal tenant when isPersonal is true', async () => {
    const client = makeCreateClient();
    mockConnect.mockResolvedValue(client);

    const tenant = await makeService().create({
      displayName: 'Personal',
      ownerUserId: 'u1',
      isPersonal: true,
    });

    expect(tenant.isPersonal).toBe(true);
  });

  it('rolls back on failure', async () => {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // slug check
      .mockRejectedValueOnce(new Error('insert failed')) // INSERT tenants fails
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    mockConnect.mockResolvedValue(client);

    await expect(makeService().create({ displayName: 'Fail', ownerUserId: 'u1' }))
      .rejects.toThrow('insert failed');

    const rollback = client.query.mock.calls.find(([sql]: [string]) => sql === 'ROLLBACK');
    expect(rollback).toBeDefined();
  });
});

// =============================================================================
// getById() / getBySlug()
// =============================================================================

describe('TenantService.getById', () => {
  it('returns null when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await makeService().getById('nope')).toBeNull();
  });

  it('maps DB row to Tenant type correctly', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 't1', slug: 'acme', display_name: 'Acme', plan_tier: 'starter',
        is_personal: false, global_brain_opt_in: false,
        suspended_at: null, deleted_at: null, created_at: now, updated_at: now,
      }],
    });

    const tenant = await makeService().getById('t1');
    expect(tenant).toMatchObject({
      id: 't1', slug: 'acme', displayName: 'Acme', plan: 'starter',
      isPersonal: false, brainOptIn: false,
    });
  });
});

describe('TenantService.getBySlug', () => {
  it('returns null when slug not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await makeService().getBySlug('unknown-slug')).toBeNull();
  });
});

// =============================================================================
// update()
// =============================================================================

describe('TenantService.update', () => {
  it('throws NOT_FOUND when tenant does not exist or is deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().update('bad-id', { displayName: 'X' }))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('returns updated tenant', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 't1', slug: 'acme', display_name: 'Acme Updated', plan_tier: 'starter',
        is_personal: false, global_brain_opt_in: true,
        suspended_at: null, deleted_at: null, created_at: now, updated_at: now,
      }],
    });

    const tenant = await makeService().update('t1', { displayName: 'Acme Updated', brainOptIn: true });
    expect(tenant.displayName).toBe('Acme Updated');
    expect(tenant.brainOptIn).toBe(true);
  });
});

// =============================================================================
// delete() — Invariant I-10
// =============================================================================

describe('TenantService.delete', () => {
  it('throws NOT_FOUND when caller is not the owner', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // owner check fails
    await expect(makeService().delete('t1', 'u-not-owner'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('throws SOLE_MEMBERLESS_USER when deletion would orphan a member (I-10)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: '1' }] }) // owner check passes
      .mockResolvedValueOnce({ rows: [{ email: 'stranded@x.com' }] }); // orphaned users found

    await expect(makeService().delete('t1', 'u-owner'))
      .rejects.toThrow(expect.objectContaining({ code: 'SOLE_MEMBERLESS_USER', statusCode: 409 }));
  });

  it('SOLE_MEMBERLESS_USER error includes affected email(s)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: '1' }] })
      .mockResolvedValueOnce({ rows: [{ email: 'stranded@x.com' }] });

    try {
      await makeService().delete('t1', 'u-owner');
      fail('should have thrown');
    } catch (err) {
      expect((err as IdentityError).message).toContain('stranded@x.com');
    }
  });

  it('soft-deletes memberships and tenant atomically when safe', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: '1' }] }) // owner check
      .mockResolvedValueOnce({ rows: [] }); // no orphaned users

    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE memberships
      .mockResolvedValueOnce({ rows: [] }) // UPDATE tenants (soft delete)
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockConnect.mockResolvedValue(client);

    await makeService().delete('t1', 'u-owner');

    const membershipUpdate = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('UPDATE memberships SET deleted_at'),
    );
    expect(membershipUpdate).toBeDefined();

    const tenantUpdate = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('UPDATE tenants SET deleted_at'),
    );
    expect(tenantUpdate).toBeDefined();
  });
});

// =============================================================================
// getUsage()
// =============================================================================

describe('TenantService.getUsage', () => {
  it('returns usage stats with correct field mapping', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })   // runs
      .mockResolvedValueOnce({ rows: [{ total: '10000' }] }) // tokens
      .mockResolvedValueOnce({ rows: [{ count: '3' }] });   // members

    const usage = await makeService().getUsage('t1');
    expect(usage).toEqual({ runsThisMonth: 5, llmTokensThisMonth: 10000, memberCount: 3 });
  });
});

// =============================================================================
// rotateApiKey()
// =============================================================================

describe('TenantService.rotateApiKey', () => {
  it('throws NOT_FOUND when caller is not owner/admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().rotateApiKey('t1', 'u-viewer'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('returns a raw API key with kzn_live_ prefix', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: '1' }] }); // auth check

    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // DELETE existing keys
      .mockResolvedValueOnce({ rows: [] }) // INSERT new key
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockConnect.mockResolvedValue(client);

    const rawKey = await makeService().rotateApiKey('t1', 'u-admin');
    expect(rawKey).toMatch(/^kzn_live_/);
  });

  it('stores only the hash (not raw key) in the DB', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: '1' }] });

    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    mockConnect.mockResolvedValue(client);

    const rawKey = await makeService().rotateApiKey('t1', 'u-admin');

    const insertCall = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO api_keys'),
    );
    const storedHash: string = insertCall![1][1];
    // Hash must not equal the raw key
    expect(storedHash).not.toBe(rawKey);
    expect(storedHash).toHaveLength(64); // SHA-256 hex
  });
});
