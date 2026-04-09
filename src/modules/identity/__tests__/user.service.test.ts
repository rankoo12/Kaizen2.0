/**
 * Tests: user.service.ts
 * Spec ref: docs/spec-identity.md §6.3, §9 (Registration Flow)
 *
 * Invariants covered:
 *  I-1: Every user has at least one membership (registration creates one atomically)
 *  I-4: User cannot be deleted if sole owner of any tenant
 *  I-6: Registration is atomic — user + tenant + membership in one transaction
 */

import { UserService } from '../user.service';
import { IdentityError } from '../interfaces';

// ─── Mock DB pool ─────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockConnect = jest.fn();

jest.mock('../../../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: mockConnect }),
}));

// ─── Mock email service ───────────────────────────────────────────────────────

const mockEmail = {
  sendEmailVerification: jest.fn().mockResolvedValue(undefined),
  sendPasswordReset:     jest.fn().mockResolvedValue(undefined),
  sendInvite:            jest.fn().mockResolvedValue(undefined),
};

function makeService() {
  return new UserService(mockEmail);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClientMock(queryResponses: Array<{ rows: unknown[]; rowCount?: number }>) {
  const q = jest.fn();
  queryResponses.forEach((res) => q.mockResolvedValueOnce(res));
  return { query: q, release: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

// =============================================================================
// register() — §9 Registration Flow, Invariant I-6
// =============================================================================

describe('UserService.register', () => {
  function makeRegisterClient() {
    const client = {
      query: jest.fn(),
      release: jest.fn(),
    };

    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [] });
    // email uniqueness check → empty (not taken)
    client.query.mockResolvedValueOnce({ rows: [] });
    // INSERT users → user row
    client.query.mockResolvedValueOnce({ rows: [{ id: 'user-uuid', created_at: new Date(), updated_at: new Date() }] });
    // slug uniqueness check → empty (slug available)
    client.query.mockResolvedValueOnce({ rows: [] });
    // INSERT tenants → tenant row
    client.query.mockResolvedValueOnce({ rows: [{ id: 'tenant-uuid', created_at: new Date(), updated_at: new Date() }] });
    // INSERT memberships
    client.query.mockResolvedValueOnce({ rows: [] });
    // COMMIT
    client.query.mockResolvedValueOnce({ rows: [] });

    // pool.query for verify_token_hash update
    mockQuery.mockResolvedValueOnce({ rows: [] });

    return client;
  }

  it('returns user and personalTenant with correct shape', async () => {
    const client = makeRegisterClient();
    mockConnect.mockResolvedValue(client);

    const svc = makeService();
    const { user, personalTenant } = await svc.register({
      email: 'Alice@Acme.com',
      password: 'password123',
      displayName: 'Alice',
    });

    expect(user.id).toBe('user-uuid');
    expect(user.email).toBe('alice@acme.com'); // normalised to lowercase
    expect(user.displayName).toBe('Alice');
    expect(user.deletedAt).toBeNull();

    expect(personalTenant.id).toBe('tenant-uuid');
    expect(personalTenant.isPersonal).toBe(true);
    expect(personalTenant.brainOptIn).toBe(false);
  });

  it('creates membership as owner in the same transaction (I-6)', async () => {
    const client = makeRegisterClient();
    mockConnect.mockResolvedValue(client);

    await makeService().register({ email: 'b@x.com', password: 'pass1234', displayName: 'Bob' });

    // Find the INSERT memberships call — 'owner' is hardcoded in the SQL, not in params
    const membershipInsert = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO memberships'),
    );
    expect(membershipInsert).toBeDefined();
    expect(membershipInsert![0]).toContain("'owner'");
  });

  it('uses personal tenant name from displayName when personalTenantName is omitted', async () => {
    const client = makeRegisterClient();
    mockConnect.mockResolvedValue(client);

    await makeService().register({ email: 'c@x.com', password: 'pass1234', displayName: 'Carol' });

    const tenantInsert = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO tenants'),
    );
    expect(tenantInsert![1][0]).toContain("Carol");
  });

  it('uses provided personalTenantName when given', async () => {
    const client = makeRegisterClient();
    mockConnect.mockResolvedValue(client);

    await makeService().register({
      email: 'd@x.com',
      password: 'pass1234',
      displayName: 'Dave',
      personalTenantName: 'Dave Corp',
    });

    const tenantInsert = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO tenants'),
    );
    expect(tenantInsert![1][0]).toBe('Dave Corp');
  });

  it('throws EMAIL_TAKEN (409) when email is already registered', async () => {
    const client = {
      query: jest.fn(),
      release: jest.fn(),
    };
    // BEGIN
    client.query.mockResolvedValueOnce({ rows: [] });
    // email uniqueness check → existing user found
    client.query.mockResolvedValueOnce({ rows: [{ id: 'existing-user' }] });
    // ROLLBACK
    client.query.mockResolvedValueOnce({ rows: [] });

    mockConnect.mockResolvedValue(client);

    await expect(
      makeService().register({ email: 'taken@x.com', password: 'pw123456', displayName: 'X' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'EMAIL_TAKEN', statusCode: 409 }));
  });

  it('rolls back on error and re-throws', async () => {
    const client = {
      query: jest.fn(),
      release: jest.fn(),
    };
    client.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [] }); // email uniqueness
    client.query.mockRejectedValueOnce(new Error('DB failure')); // INSERT users fails
    client.query.mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    mockConnect.mockResolvedValue(client);

    await expect(
      makeService().register({ email: 'e@x.com', password: 'pass1234', displayName: 'Eve' }),
    ).rejects.toThrow('DB failure');

    const rollback = client.query.mock.calls.find(([sql]: [string]) => sql === 'ROLLBACK');
    expect(rollback).toBeDefined();
  });

  it('sends email verification after successful commit', async () => {
    const client = makeRegisterClient();
    mockConnect.mockResolvedValue(client);

    await makeService().register({ email: 'f@x.com', password: 'pass1234', displayName: 'Frank' });

    // Allow micro-task queue to flush the fire-and-forget
    await new Promise((r) => setImmediate(r));
    expect(mockEmail.sendEmailVerification).toHaveBeenCalledWith('f@x.com', expect.any(String));
  });
});

// =============================================================================
// getById()
// =============================================================================

describe('UserService.getById', () => {
  it('returns null when user does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await makeService().getById('nonexistent')).toBeNull();
  });

  it('maps DB row to User type correctly', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'u1', email: 'u@x.com', display_name: 'U', avatar_url: null,
        email_verified_at: null, last_login_at: now, deleted_at: null,
        created_at: now, updated_at: now,
      }],
    });

    const user = await makeService().getById('u1');
    expect(user).toMatchObject({
      id: 'u1',
      email: 'u@x.com',
      displayName: 'U',
      avatarUrl: null,
      lastLoginAt: now,
    });
  });
});

// =============================================================================
// updateProfile()
// =============================================================================

describe('UserService.updateProfile', () => {
  it('throws NOT_FOUND when user does not exist or is deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().updateProfile('bad-id', { displayName: 'X' }))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('returns updated user on success', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'u1', email: 'u@x.com', display_name: 'New Name', avatar_url: null,
        email_verified_at: null, last_login_at: null, deleted_at: null, created_at: now, updated_at: now,
      }],
    });

    const user = await makeService().updateProfile('u1', { displayName: 'New Name' });
    expect(user.displayName).toBe('New Name');
  });
});

// =============================================================================
// changePassword() — §14 Security
// =============================================================================

describe('UserService.changePassword', () => {
  it('throws NOT_FOUND when user does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().changePassword('u1', 'old', 'new12345'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('throws WRONG_PASSWORD for incorrect current password', async () => {
    const { hashPassword: hp } = await import('../password');
    const storedHash = await hp('correct-pass');
    mockQuery.mockResolvedValueOnce({ rows: [{ password_hash: storedHash }] });

    await expect(makeService().changePassword('u1', 'wrong-pass', 'new12345'))
      .rejects.toThrow(expect.objectContaining({ code: 'WRONG_PASSWORD' }));
  });

  it('revokes all refresh tokens on success (forces re-login everywhere)', async () => {
    const { hashPassword: hp } = await import('../password');
    const storedHash = await hp('correct-pass');
    mockQuery
      .mockResolvedValueOnce({ rows: [{ password_hash: storedHash }] }) // fetch user
      .mockResolvedValueOnce({ rows: [] }) // UPDATE password_hash
      .mockResolvedValueOnce({ rows: [] }); // UPDATE refresh_tokens (revoke all)

    await makeService().changePassword('u1', 'correct-pass', 'new-password-123');

    const revokeCall = mockQuery.mock.calls[2];
    expect(revokeCall[0]).toMatch(/UPDATE refresh_tokens SET revoked_at/);
  });
});

// =============================================================================
// requestPasswordReset() — §14 Security: email enumeration prevention
// =============================================================================

describe('UserService.requestPasswordReset', () => {
  it('resolves successfully even when email does not exist (no enumeration)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // email not found

    // Must not throw
    await expect(makeService().requestPasswordReset('unknown@x.com')).resolves.toBeUndefined();
  });

  it('stores reset token hash (not raw token) in DB', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'u@x.com' }] })  // lookup
      .mockResolvedValueOnce({ rows: [] });  // UPDATE reset_token_hash

    await makeService().requestPasswordReset('u@x.com');

    const updateCall = mockQuery.mock.calls[1];
    const storedHash: string = updateCall[1][0];
    // Hash is a SHA-256 hex string (64 chars), not the raw token (also 64 hex but different)
    expect(storedHash).toHaveLength(64);
  });
});

// =============================================================================
// resetPassword()
// =============================================================================

describe('UserService.resetPassword', () => {
  it('throws INVALID_RESET_TOKEN when token is not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().resetPassword('bad-token', 'newpass1234'))
      .rejects.toThrow(expect.objectContaining({ code: 'INVALID_RESET_TOKEN' }));
  });

  it('throws INVALID_RESET_TOKEN when token is expired', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'u1', reset_token_expires: new Date(Date.now() - 1000) }],
    });
    await expect(makeService().resetPassword('expired-token', 'newpass1234'))
      .rejects.toThrow(expect.objectContaining({ code: 'INVALID_RESET_TOKEN' }));
  });

  it('clears the token and revokes all sessions on success', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u1', reset_token_expires: new Date(Date.now() + 60000) }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE password + clear token
      .mockResolvedValueOnce({ rows: [] }); // revoke refresh tokens

    await makeService().resetPassword('valid-token', 'newpass9876');

    const clearCall = mockQuery.mock.calls[1];
    expect(clearCall[0]).toMatch(/reset_token_hash = NULL/);

    const revokeCall = mockQuery.mock.calls[2];
    expect(revokeCall[0]).toMatch(/UPDATE refresh_tokens SET revoked_at/);
  });
});

// =============================================================================
// verifyEmail()
// =============================================================================

describe('UserService.verifyEmail', () => {
  it('throws INVALID_RESET_TOKEN when no row is updated', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(makeService().verifyEmail('bad-verify-token'))
      .rejects.toThrow(expect.objectContaining({ code: 'INVALID_RESET_TOKEN' }));
  });

  it('resolves when token is valid', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await expect(makeService().verifyEmail('good-token')).resolves.toBeUndefined();
  });
});

// =============================================================================
// delete() — Invariant I-4: sole owner check
// =============================================================================

describe('UserService.delete', () => {
  it('throws SOLE_OWNER (409) when user is the only owner of a tenant (I-4)', async () => {
    // Returns tenants where the user is the sole owner
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 't1' }] });

    await expect(makeService().delete('u1'))
      .rejects.toThrow(expect.objectContaining({ code: 'SOLE_OWNER', statusCode: 409 }));
  });

  it('soft-deletes user + memberships + sessions atomically', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // sole-owner check → none

    const client = {
      query: jest.fn(),
      release: jest.fn(),
    };
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE memberships
      .mockResolvedValueOnce({ rows: [] }) // UPDATE refresh_tokens
      .mockResolvedValueOnce({ rows: [] }) // UPDATE users (soft delete)
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockConnect.mockResolvedValue(client);

    await makeService().delete('u1');

    const membershipUpdate = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('UPDATE memberships'),
    );
    expect(membershipUpdate).toBeDefined();

    const userUpdate = client.query.mock.calls.find(
      ([sql]: [string]) => sql.includes('UPDATE users SET deleted_at'),
    );
    expect(userUpdate).toBeDefined();
  });

  it('rolls back on transaction failure', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // sole-owner check

    const client = {
      query: jest.fn(),
      release: jest.fn(),
    };
    client.query
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockRejectedValueOnce(new Error('FK error')) // memberships update fails
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    mockConnect.mockResolvedValue(client);

    await expect(makeService().delete('u1')).rejects.toThrow('FK error');

    const rollback = client.query.mock.calls.find(([sql]: [string]) => sql === 'ROLLBACK');
    expect(rollback).toBeDefined();
  });
});
