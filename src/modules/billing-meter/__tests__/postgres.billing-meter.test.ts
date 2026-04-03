import { PostgresBillingMeter } from '../postgres.billing-meter';
import type { IObservability } from '../../observability/interfaces';

// Mock the transaction helper so no real DB connection is needed
jest.mock('../../../db/transaction', () => ({
  withTenantTransaction: jest.fn(),
}));

import { withTenantTransaction } from '../../../db/transaction';

const mockObservability: jest.Mocked<IObservability> = {
  startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
};

describe('PostgresBillingMeter', () => {
  let billingMeter: PostgresBillingMeter;
  let mockClient: { query: jest.Mock };

  beforeEach(() => {
    mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    // withTenantTransaction calls our callback with a mock client
    (withTenantTransaction as jest.Mock).mockImplementation(
      async (_tenantId: string, cb: (client: unknown) => Promise<unknown>) => cb(mockClient),
    );

    billingMeter = new PostgresBillingMeter(mockObservability);
  });

  afterEach(() => jest.clearAllMocks());

  it('inserts a billing event with the correct SQL and parameters', async () => {
    await billingMeter.emit({
      tenantId: '00000000-0000-0000-0000-000000000001',
      eventType: 'LLM_CALL',
      quantity: 1500,
      unit: 'tokens',
      metadata: { model: 'gpt-4' },
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO billing_events'),
      expect.arrayContaining(['LLM_CALL', 1500, 'tokens']),
    );
  });

  it('increments the observability metric on success', async () => {
    await billingMeter.emit({
      tenantId: '00000000-0000-0000-0000-000000000001',
      eventType: 'TEST_RUN_STARTED',
      quantity: 1,
      unit: 'runs',
    });

    expect(mockObservability.increment).toHaveBeenCalledWith(
      'billing.events_emitted',
      { type: 'TEST_RUN_STARTED' },
    );
  });

  it('swallows DB errors without throwing — fire-and-forget contract', async () => {
    (withTenantTransaction as jest.Mock).mockRejectedValue(new Error('DB is down'));

    await expect(
      billingMeter.emit({
        tenantId: '00000000-0000-0000-0000-000000000001',
        eventType: 'LLM_CALL',
        quantity: 1,
        unit: 'tokens',
      }),
    ).resolves.not.toThrow();

    expect(mockObservability.log).toHaveBeenCalledWith(
      'error',
      'billing_emit_failed',
      expect.any(Object),
    );
  });

  it('does not include metadata param when metadata is undefined', async () => {
    await billingMeter.emit({
      tenantId: '00000000-0000-0000-0000-000000000001',
      eventType: 'TEST_RUN_STARTED',
      quantity: 1,
      unit: 'runs',
    });

    const params = mockClient.query.mock.calls[0][1] as unknown[];
    // Last param should be null (no metadata)
    expect(params[params.length - 1]).toBeNull();
  });
});
