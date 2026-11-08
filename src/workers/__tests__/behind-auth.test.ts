import { resolveBehindAuth } from '../behind-auth';
import { tenantQuery } from '../../db/transaction';

jest.mock('../../db/transaction', () => ({ tenantQuery: jest.fn() }));

/**
 * Finding #14, defense in depth. `behindAuth` is the privacy boundary — nothing
 * learned on a signed-in page may leave the tenant. The case-run enqueue site
 * sends it (migration 045), but a protection that depends on every producer
 * remembering a flag is one forgotten enqueue site away from leaking, so the
 * worker re-derives it from the case.
 */
const q = tenantQuery as jest.Mock;
const run = { tenantId: 't1', runId: 'r1' };

describe('resolveBehindAuth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('trusts the payload flag and does not even query', async () => {
    expect(await resolveBehindAuth({ ...run, payloadFlag: true })).toEqual({ behindAuth: true, source: 'payload' });
    expect(q).not.toHaveBeenCalled();
  });

  it('derives protection from an authenticated CASE when the producer forgot the flag', async () => {
    q.mockResolvedValue({ rows: [{ authenticated: true }] });
    expect(await resolveBehindAuth({ ...run, payloadFlag: false })).toEqual({ behindAuth: true, source: 'case' });
  });

  it('leaves a public case unprotected — ordinary behavior is unchanged', async () => {
    q.mockResolvedValue({ rows: [{ authenticated: false }] });
    expect(await resolveBehindAuth({ ...run, payloadFlag: false })).toEqual({ behindAuth: false, source: 'none' });
  });

  it('a run with no case (the direct POST /runs path) has nothing to look up — unprotected, not an error', async () => {
    q.mockResolvedValue({ rows: [] });
    expect(await resolveBehindAuth({ ...run, payloadFlag: false })).toEqual({ behindAuth: false, source: 'none' });
  });

  it('FAILS CLOSED: if the lookup throws, the run is protected — losing one run\'s learnings beats leaking a customer\'s UI vocabulary', async () => {
    q.mockRejectedValue(new Error('connection reset'));
    expect(await resolveBehindAuth({ ...run, payloadFlag: false })).toEqual({ behindAuth: true, source: 'lookup_failed' });
  });

  it('only a literal true counts as authenticated — NULL or a truthy-looking value does not', async () => {
    for (const authenticated of [null, undefined, 0, 'false'] as unknown[]) {
      q.mockResolvedValue({ rows: [{ authenticated }] });
      expect((await resolveBehindAuth({ ...run, payloadFlag: false })).behindAuth).toBe(false);
    }
  });

  it('scopes the lookup to the run AND the tenant, on both sides of the join', async () => {
    q.mockResolvedValue({ rows: [] });
    await resolveBehindAuth({ tenantId: 'tenant-9', runId: 'run-9', payloadFlag: false });

    const [tenantArg, sql, params] = q.mock.calls[0];
    expect(tenantArg).toBe('tenant-9'); // runs inside that tenant's RLS transaction
    expect(params).toEqual(['run-9', 'tenant-9']);
    expect(String(sql)).toMatch(/r\.tenant_id = \$2/);
    expect(String(sql)).toMatch(/tc\.tenant_id = r\.tenant_id/); // never joins across tenants
    expect(String(sql)).toMatch(/tc\.authenticated/);
  });
});
