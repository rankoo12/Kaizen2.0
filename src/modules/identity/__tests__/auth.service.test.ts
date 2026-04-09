/**
 * Tests: auth.service.ts
 * Spec ref: docs/spec-identity.md §6.1, §8 (Auth Flow), §11 (JWT Contract)
 *
 * Strategy: mock getPool() and ioredis. All DB interactions are captured via
 * jest.fn() query mocks so no real Postgres or Redis connection is required.
 */

import { AuthService, type JWTSigner } from '../auth.service';
import { hashPassword } from '../password';

// ─── Mock DB pool ─────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockGetdel = jest.fn();
const mockSetex = jest.fn();

jest.mock('../../../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRedis() {
  return { getdel: mockGetdel, setex: mockSetex } as any;
}

function makeJwt(claims?: object): JWTSigner {
  return {
    sign: jest.fn().mockReturnValue('signed-token'),
    verify: jest.fn().mockReturnValue(claims ?? { sub: 'u1', tenantId: 't1', role: 'member', email: 'u@x.com' }),
  };
}

async function makeService(jwtClaims?: object) {
  const redis = makeRedis();
  const jwt = makeJwt(jwtClaims);
  const svc = new AuthService(redis, jwt);
  return { svc, redis, jwt };
}

// ─── Convenience: build a real password hash so login actually works ──────────

let realPasswordHash: string;
beforeAll(async () => {
  realPasswordHash = await hashPassword('correct-horse');
});

beforeEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// login()
// =============================================================================

describe('AuthService.login', () => {
  it('returns null when user is not found (and still runs dummy hash)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no user row
    const { svc } = await makeService();

    const result = await svc.login('unknown@x.com', 'pass');
    expect(result).toBeNull();
  });

  it('returns null on wrong password', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', password_hash: realPasswordHash }] });
    const { svc } = await makeService();

    const result = await svc.login('user@x.com', 'wrong-password');
    expect(result).toBeNull();
  });

  it('returns LoginResult with sessionToken and tenant list on success', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u1', password_hash: realPasswordHash }] }) // user lookup
      .mockResolvedValueOnce({ rows: [{ id: 't1', slug: 'ws', display_name: 'WS', is_personal: true, role: 'owner' }] }) // getUserTenants
      .mockResolvedValueOnce({ rows: [] }); // last_login_at update (fire-and-forget)

    mockSetex.mockResolvedValue('OK');

    const { svc } = await makeService();
    const result = await svc.login('user@x.com', 'correct-horse');

    expect(result).not.toBeNull();
    expect(typeof result!.sessionToken).toBe('string');
    expect(result!.sessionToken).toHaveLength(64); // 32 bytes → hex
    expect(result!.tenants).toHaveLength(1);
    expect(result!.tenants[0].id).toBe('t1');
    expect(result!.tenants[0].role).toBe('owner');
  });

  it('stores session token hash in Redis with 5-minute TTL', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'u1', password_hash: realPasswordHash }] })
      .mockResolvedValueOnce({ rows: [] }) // tenants
      .mockResolvedValueOnce({ rows: [] }); // last_login_at

    mockSetex.mockResolvedValue('OK');

    const { svc } = await makeService();
    await svc.login('user@x.com', 'correct-horse');

    expect(mockSetex).toHaveBeenCalledTimes(1);
    const [key, ttl, value] = mockSetex.mock.calls[0];
    expect(key).toMatch(/^login_session:/);
    expect(ttl).toBe(300); // 5 * 60
    expect(value).toBe('u1');
  });

  it('normalises email to lowercase', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { svc } = await makeService();

    await svc.login('User@X.COM', 'pw');
    expect(mockQuery.mock.calls[0][1][0]).toBe('user@x.com');
  });
});

// =============================================================================
// issueToken()
// =============================================================================

describe('AuthService.issueToken', () => {
  it('returns null when session token is not found in Redis', async () => {
    mockGetdel.mockResolvedValue(null);
    const { svc } = await makeService();

    const result = await svc.issueToken('bad-session-token', 't1');
    expect(result).toBeNull();
  });

  it('delegates to issueTokenDirect on valid session token', async () => {
    mockGetdel.mockResolvedValue('u1'); // Redis hit
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: 'owner', email: 'u@x.com', suspended_at: null }],
    }); // membership check
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT refresh_token

    const { svc, jwt } = await makeService();
    const result = await svc.issueToken('valid-session', 't1');

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('signed-token');
    expect((jwt.sign as jest.Mock)).toHaveBeenCalled();
  });

  it('session token is single-use (getdel removes it)', async () => {
    mockGetdel.mockResolvedValue(null); // already consumed
    const { svc } = await makeService();

    const r1 = await svc.issueToken('token', 't1');
    const r2 = await svc.issueToken('token', 't1');
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });
});

// =============================================================================
// issueTokenDirect()
// =============================================================================

describe('AuthService.issueTokenDirect', () => {
  it('throws when there is no active membership', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { svc } = await makeService();

    await expect(svc.issueTokenDirect('u1', 't1')).rejects.toThrow('No active membership');
  });

  it('throws TENANT_SUSPENDED when tenant is suspended', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: 'member', email: 'u@x.com', suspended_at: new Date() }],
    });
    const { svc } = await makeService();

    await expect(svc.issueTokenDirect('u1', 't1')).rejects.toThrow('TENANT_SUSPENDED');
  });

  it('returns a valid TokenPair with correct expiresIn', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'admin', email: 'u@x.com', suspended_at: null }] })
      .mockResolvedValueOnce({ rows: [] }); // INSERT refresh_token

    const { svc } = await makeService();
    const result = await svc.issueTokenDirect('u1', 't1');

    expect(result.accessToken).toBe('signed-token');
    expect(typeof result.refreshToken).toBe('string');
    expect(result.refreshToken).toHaveLength(64);
    expect(result.expiresIn).toBe(900); // 15 * 60
  });

  it('inserts refresh token hash (not raw) into DB', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'owner', email: 'u@x.com', suspended_at: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const { svc } = await makeService();
    const result = await svc.issueTokenDirect('u1', 't1');

    const insertCall = mockQuery.mock.calls[1];
    const storedHash: string = insertCall[1][2];
    // The hash must NOT be the raw token
    expect(storedHash).not.toBe(result.refreshToken);
    // It is a SHA-256 hex (64 chars)
    expect(storedHash).toHaveLength(64);
  });

  it('signs JWT with correct claims shape', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'viewer', email: 'v@x.com', suspended_at: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const { svc, jwt } = await makeService();
    await svc.issueTokenDirect('u-viewer', 't-acme');

    const signCall = (jwt.sign as jest.Mock).mock.calls[0];
    expect(signCall[0]).toMatchObject({ sub: 'u-viewer', tenantId: 't-acme', role: 'viewer', email: 'v@x.com' });
  });
});

// =============================================================================
// refresh()
// =============================================================================

describe('AuthService.refresh', () => {
  it('returns null for unknown token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { svc } = await makeService();

    expect(await svc.refresh('unknown')).toBeNull();
  });

  it('returns null for revoked token', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'rt1', user_id: 'u1', tenant_id: 't1', expires_at: new Date(Date.now() + 1e6), revoked_at: new Date() }],
    });
    const { svc } = await makeService();

    expect(await svc.refresh('revoked-token')).toBeNull();
  });

  it('returns null for expired token', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'rt1', user_id: 'u1', tenant_id: 't1', expires_at: new Date(Date.now() - 1000), revoked_at: null }],
    });
    const { svc } = await makeService();

    expect(await svc.refresh('expired-token')).toBeNull();
  });

  it('rotates token: revokes old and issues new TokenPair', async () => {
    const future = new Date(Date.now() + 86_400_000);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'rt1', user_id: 'u1', tenant_id: 't1', expires_at: future, revoked_at: null }] }) // lookup
      .mockResolvedValueOnce({ rows: [] })   // UPDATE revoked_at
      .mockResolvedValueOnce({ rows: [{ role: 'member', email: 'u@x.com', suspended_at: null }] }) // issueTokenDirect membership
      .mockResolvedValueOnce({ rows: [] });  // INSERT new refresh_token

    const { svc } = await makeService();
    const result = await svc.refresh('valid-refresh');

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('signed-token');

    // Verify that the old token was revoked
    const revokeCall = mockQuery.mock.calls[1];
    expect(revokeCall[0]).toMatch(/UPDATE refresh_tokens SET revoked_at/);
    expect(revokeCall[1][0]).toBe('rt1');
  });
});

// =============================================================================
// logout() / logoutAll()
// =============================================================================

describe('AuthService.logout', () => {
  it('issues an UPDATE to revoke the specific token', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { svc } = await makeService();

    await svc.logout('raw-refresh-token');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE refresh_tokens SET revoked_at/);
    // Stored hash is passed (NOT the raw token)
    expect(params[0]).toHaveLength(64);
  });
});

describe('AuthService.logoutAll', () => {
  it('revokes all tokens for a given userId', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { svc } = await makeService();

    await svc.logoutAll('user-123');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE refresh_tokens SET revoked_at/);
    expect(params[0]).toBe('user-123');
  });
});

// =============================================================================
// verifyAccessToken()
// =============================================================================

describe('AuthService.verifyAccessToken', () => {
  it('returns claims when JWT is valid', async () => {
    const claims = { sub: 'u1', tenantId: 't1', role: 'admin' as const, email: 'a@x.com' };
    const { svc } = await makeService(claims);

    const result = await svc.verifyAccessToken('valid.jwt.token');
    expect(result).toMatchObject(claims);
  });

  it('returns null when JWT verify throws', async () => {
    const jwt = { sign: jest.fn(), verify: jest.fn().mockImplementation(() => { throw new Error('expired'); }) };
    const svc = new AuthService(makeRedis(), jwt);

    expect(await svc.verifyAccessToken('bad.jwt')).toBeNull();
  });

  it('returns null when required claims are missing', async () => {
    const jwt = { sign: jest.fn(), verify: jest.fn().mockReturnValue({ sub: 'u1' }) }; // missing tenantId, role
    const svc = new AuthService(makeRedis(), jwt);

    expect(await svc.verifyAccessToken('incomplete.jwt')).toBeNull();
  });

  it('does NOT call the database (pure JWT path)', async () => {
    const { svc } = await makeService();
    await svc.verifyAccessToken('some.token');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
