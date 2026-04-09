/**
 * Tests: membership.service.ts
 * Spec ref: docs/spec-identity.md §6.4, §10 (Invite Flow)
 *
 * Invariants covered:
 *  I-3: Tenant owner cannot be removed
 *  I-5: Owner role cannot be changed via changeRole — use transferOwnership
 *  I-2: Every tenant has exactly one owner (transferOwnership is atomic)
 */

import { MembershipService } from '../membership.service';
import { IdentityError } from '../interfaces';

// ─── Mock DB pool ─────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockConnect = jest.fn();

jest.mock('../../../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: mockConnect }),
}));

const mockEmail = {
  sendEmailVerification: jest.fn().mockResolvedValue(undefined),
  sendPasswordReset:     jest.fn().mockResolvedValue(undefined),
  sendInvite:            jest.fn().mockResolvedValue(undefined),
};

function makeService() {
  return new MembershipService(mockEmail);
}

beforeEach(() => jest.clearAllMocks());

// =============================================================================
// listMembers()
// =============================================================================

describe('MembershipService.listMembers', () => {
  it('returns mapped MembershipDetail array', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm1', tenant_id: 't1', user_id: 'u1', role: 'owner',
        invited_by: null, accepted_at: now, deleted_at: null, created_at: now,
        u_id: 'u1', u_email: 'owner@x.com', u_display_name: 'Owner', u_avatar_url: null,
      }],
    });

    const members = await makeService().listMembers('t1');
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('owner');
    expect(members[0].user.email).toBe('owner@x.com');
  });

  it('returns empty array when tenant has no active members', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await makeService().listMembers('t-empty')).toEqual([]);
  });
});

// =============================================================================
// listPendingInvites()
// =============================================================================

describe('MembershipService.listPendingInvites', () => {
  it('returns pending invite list', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'inv1', tenant_id: 't1', invited_by: 'u1', email: 'new@x.com',
        role: 'member', expires_at: now, accepted_at: null, revoked_at: null, created_at: now,
      }],
    });

    const invites = await makeService().listPendingInvites('t1');
    expect(invites).toHaveLength(1);
    expect(invites[0].email).toBe('new@x.com');
    expect(invites[0].role).toBe('member');
  });
});

// =============================================================================
// invite()
// =============================================================================

describe('MembershipService.invite', () => {
  it('throws ALREADY_MEMBER when email already has active membership', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'm1' }] }); // existing membership found

    await expect(makeService().invite('t1', 'admin-user', { email: 'existing@x.com', role: 'member' }))
      .rejects.toThrow(expect.objectContaining({ code: 'ALREADY_MEMBER', statusCode: 409 }));
  });

  it('throws INVITE_EXISTS when pending invite already exists', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })       // no existing membership
      .mockResolvedValueOnce({ rows: [{ id: 'inv1' }] }); // pending invite found

    await expect(makeService().invite('t1', 'admin-user', { email: 'pending@x.com', role: 'member' }))
      .rejects.toThrow(expect.objectContaining({ code: 'INVITE_EXISTS', statusCode: 409 }));
  });

  it('creates invite with 7-day expiry', async () => {
    const now = new Date();
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no membership
      .mockResolvedValueOnce({ rows: [] }) // no pending invite
      .mockResolvedValueOnce({             // INSERT invite
        rows: [{
          id: 'inv-new', tenant_id: 't1', invited_by: 'u1', email: 'new@x.com',
          role: 'admin', expires_at: new Date(now.getTime() + 7 * 86_400_000),
          accepted_at: null, revoked_at: null, created_at: now,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ display_name: 'My Tenant' }] }) // tenant name
      .mockResolvedValueOnce({ rows: [{ display_name: 'Admin User' }] }); // inviter name

    const invite = await makeService().invite('t1', 'u1', { email: 'new@x.com', role: 'admin' });
    expect(invite.id).toBe('inv-new');
    expect(invite.role).toBe('admin');

    // Verify expiry is ~7 days from now
    const diffMs = invite.expiresAt.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(6 * 86_400_000);
    expect(diffMs).toBeLessThanOrEqual(7 * 86_400_000 + 5000);
  });

  it('stores token hash (not raw token) in DB', async () => {
    const now = new Date();
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'inv', tenant_id: 't1', invited_by: 'u1', email: 'x@x.com', role: 'viewer',
          expires_at: new Date(now.getTime() + 86_400_000), accepted_at: null, revoked_at: null, created_at: now,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ display_name: 'T' }] })
      .mockResolvedValueOnce({ rows: [{ display_name: 'Admin' }] });

    await makeService().invite('t1', 'u1', { email: 'x@x.com', role: 'viewer' });

    const insertCall = mockQuery.mock.calls[2];
    const storedTokenHash: string = insertCall[1][4]; // 5th param is token_hash
    expect(storedTokenHash).toHaveLength(64); // SHA-256 hex
  });

  it('normalises email to lowercase', async () => {
    const now = new Date();
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'inv2', tenant_id: 't1', invited_by: 'u1', email: 'user@x.com', role: 'member',
          expires_at: now, accepted_at: null, revoked_at: null, created_at: now,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ display_name: 'T' }] })
      .mockResolvedValueOnce({ rows: [{ display_name: 'A' }] });

    await makeService().invite('t1', 'u1', { email: 'USER@X.COM', role: 'member' });

    const memberCheckCall = mockQuery.mock.calls[0];
    expect(memberCheckCall[1][1]).toBe('user@x.com');
  });
});

// =============================================================================
// acceptInvite()
// =============================================================================

describe('MembershipService.acceptInvite', () => {
  it('throws INVITE_NOT_FOUND when token does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().acceptInvite('bad-token', 'u1'))
      .rejects.toThrow(expect.objectContaining({ code: 'INVITE_NOT_FOUND' }));
  });

  it('throws INVITE_REVOKED when invite was revoked', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'inv1', tenant_id: 't1', email: 'x@x.com', role: 'member',
        expires_at: new Date(Date.now() + 86_400_000), accepted_at: null, revoked_at: new Date(),
      }],
    });
    await expect(makeService().acceptInvite('revoked', 'u1'))
      .rejects.toThrow(expect.objectContaining({ code: 'INVITE_REVOKED' }));
  });

  it('throws INVITE_EXPIRED when invite has expired', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'inv1', tenant_id: 't1', email: 'x@x.com', role: 'member',
        expires_at: new Date(Date.now() - 1000), accepted_at: null, revoked_at: null,
      }],
    });
    await expect(makeService().acceptInvite('expired', 'u1'))
      .rejects.toThrow(expect.objectContaining({ code: 'INVITE_EXPIRED' }));
  });

  it('throws INVITE_NOT_FOUND when invite is already accepted', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'inv1', tenant_id: 't1', email: 'x@x.com', role: 'member',
        expires_at: new Date(Date.now() + 86_400_000), accepted_at: new Date(), revoked_at: null,
      }],
    });
    await expect(makeService().acceptInvite('consumed', 'u1'))
      .rejects.toThrow(expect.objectContaining({ code: 'INVITE_NOT_FOUND' }));
  });

  it('creates membership and marks invite accepted atomically', async () => {
    const future = new Date(Date.now() + 86_400_000);
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'inv1', tenant_id: 't1', email: 'x@x.com', role: 'member',
        expires_at: future, accepted_at: null, revoked_at: null,
      }],
    });

    const client = {
      query: jest.fn(),
      release: jest.fn(),
    };
    const now = new Date();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE invites accepted_at
      .mockResolvedValueOnce({             // INSERT memberships
        rows: [{
          id: 'm-new', tenant_id: 't1', user_id: 'u1', role: 'member',
          invited_by: null, accepted_at: now, deleted_at: null, created_at: now,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockConnect.mockResolvedValue(client);

    const membership = await makeService().acceptInvite('valid-token', 'u1');
    expect(membership.tenantId).toBe('t1');
    expect(membership.role).toBe('member');
    expect(membership.userId).toBe('u1');
  });
});

// =============================================================================
// revokeInvite()
// =============================================================================

describe('MembershipService.revokeInvite', () => {
  it('throws INVITE_NOT_FOUND when invite does not exist or caller lacks permission', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().revokeInvite('inv1', 'not-an-admin'))
      .rejects.toThrow(expect.objectContaining({ code: 'INVITE_NOT_FOUND' }));
  });

  it('sets revoked_at when caller is admin/owner', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't1' }] }) // auth check passes
      .mockResolvedValueOnce({ rows: [] }); // UPDATE revoked_at

    await makeService().revokeInvite('inv1', 'admin-user');
    const revokeCall = mockQuery.mock.calls[1];
    expect(revokeCall[0]).toMatch(/UPDATE invites SET revoked_at/);
  });
});

// =============================================================================
// changeRole() — Invariant I-5: owner role protection
// =============================================================================

describe('MembershipService.changeRole', () => {
  it('throws CANNOT_CHANGE_OWNER_ROLE when target membership is owner (I-5)', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm1', tenant_id: 't1', user_id: 'u-owner', role: 'owner',
        invited_by: null, accepted_at: now, deleted_at: null, created_at: now,
      }],
    });

    await expect(makeService().changeRole('m1', 'admin', 'admin-user'))
      .rejects.toThrow(expect.objectContaining({ code: 'CANNOT_CHANGE_OWNER_ROLE', statusCode: 409 }));
  });

  it('throws CANNOT_CHANGE_OWNER_ROLE when newRole is owner (I-5)', async () => {
    const now = new Date();
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'm1', tenant_id: 't1', user_id: 'u1', role: 'member',
        invited_by: null, accepted_at: now, deleted_at: null, created_at: now,
      }],
    });

    await expect(makeService().changeRole('m1', 'owner', 'admin-user'))
      .rejects.toThrow(expect.objectContaining({ code: 'CANNOT_CHANGE_OWNER_ROLE', statusCode: 409 }));
  });

  it('throws NOT_FOUND when membership does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().changeRole('bad-id', 'viewer', 'admin'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('changes role successfully when caller is admin/owner', async () => {
    const now = new Date();
    mockQuery
      .mockResolvedValueOnce({ // fetch target membership
        rows: [{
          id: 'm1', tenant_id: 't1', user_id: 'u-member', role: 'member',
          invited_by: null, accepted_at: now, deleted_at: null, created_at: now,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: '1' }] }) // assertCallerCanManage → passes
      .mockResolvedValueOnce({ // UPDATE membership
        rows: [{
          id: 'm1', tenant_id: 't1', user_id: 'u-member', role: 'viewer',
          invited_by: null, accepted_at: now, deleted_at: null, created_at: now,
        }],
      });

    const membership = await makeService().changeRole('m1', 'viewer', 'admin-user');
    expect(membership.role).toBe('viewer');
  });
});

// =============================================================================
// transferOwnership() — Invariants I-2, I-3
// =============================================================================

describe('MembershipService.transferOwnership', () => {
  function makeTransferClient(currentOwnerFound: boolean, newOwnerFound: boolean) {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: currentOwnerFound ? [{ id: 'm-owner' }] : [] }) // verify current owner
      .mockResolvedValueOnce({ rows: newOwnerFound ? [{ id: 'm-new' }] : [] }) // verify new owner membership
      .mockResolvedValueOnce({ rows: [] }) // demote current owner → admin
      .mockResolvedValueOnce({ rows: [] }) // promote new owner
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    return client;
  }

  it('throws NOT_FOUND when current owner is not found', async () => {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // current owner lookup → not found
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    mockConnect.mockResolvedValue(client);

    await expect(makeService().transferOwnership('t1', 'u-new', 'u-not-owner'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('throws NOT_FOUND when new owner has no active membership', async () => {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'm1' }] }) // current owner found
      .mockResolvedValueOnce({ rows: [] }) // new owner membership → not found
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    mockConnect.mockResolvedValue(client);

    await expect(makeService().transferOwnership('t1', 'u-not-member', 'u-owner'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('atomically demotes current owner to admin and promotes new owner (I-2, I-3)', async () => {
    const client = makeTransferClient(true, true);
    mockConnect.mockResolvedValue(client);

    await makeService().transferOwnership('t1', 'u-new', 'u-current');

    // Check demote call (current owner → admin)
    const demoteCall = client.query.mock.calls[3];
    expect(demoteCall[0]).toMatch(/UPDATE memberships SET role = 'admin'/);
    expect(demoteCall[1]).toContain('u-current');

    // Check promote call (new owner → owner)
    const promoteCall = client.query.mock.calls[4];
    expect(promoteCall[0]).toMatch(/UPDATE memberships SET role = 'owner'/);
    expect(promoteCall[1]).toContain('u-new');
  });

  it('runs both changes in a single transaction', async () => {
    const client = makeTransferClient(true, true);
    mockConnect.mockResolvedValue(client);

    await makeService().transferOwnership('t1', 'u-new', 'u-current');

    const beginCall = client.query.mock.calls[0][0];
    const commitCall = client.query.mock.calls[5][0];
    expect(beginCall).toBe('BEGIN');
    expect(commitCall).toBe('COMMIT');
  });
});

// =============================================================================
// removeMember() — Invariant I-3: owner cannot be removed
// =============================================================================

describe('MembershipService.removeMember', () => {
  it('throws NOT_FOUND when membership does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(makeService().removeMember('bad-id', 'caller'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('throws CANNOT_REMOVE_OWNER when target is the owner (I-3)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ tenant_id: 't1', user_id: 'u-owner', role: 'owner' }],
    });

    await expect(makeService().removeMember('m-owner', 'caller'))
      .rejects.toThrow(expect.objectContaining({ code: 'CANNOT_REMOVE_OWNER', statusCode: 409 }));
  });

  it('allows a member to remove themselves (self-leave)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't1', user_id: 'u-self', role: 'member' }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE soft delete

    await makeService().removeMember('m-self', 'u-self');

    const deleteCall = mockQuery.mock.calls[1];
    expect(deleteCall[0]).toMatch(/UPDATE memberships SET deleted_at/);
  });

  it('allows admin to remove other members', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't1', user_id: 'u-member', role: 'member' }] })
      .mockResolvedValueOnce({ rows: [{ id: '1' }] }) // assertCallerCanManage → admin passes
      .mockResolvedValueOnce({ rows: [] }); // soft delete

    await makeService().removeMember('m-member', 'u-admin');

    const deleteCall = mockQuery.mock.calls[2];
    expect(deleteCall[0]).toMatch(/UPDATE memberships SET deleted_at/);
  });

  it('throws NOT_FOUND when caller is not admin/owner and tries to remove others', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't1', user_id: 'u-member', role: 'member' }] })
      .mockResolvedValueOnce({ rows: [] }); // assertCallerCanManage → fails (no row)

    await expect(makeService().removeMember('m-member', 'u-viewer'))
      .rejects.toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
