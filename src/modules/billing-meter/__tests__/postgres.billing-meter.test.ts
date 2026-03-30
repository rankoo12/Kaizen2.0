import { PostgresBillingMeter } from '../postgres.billing-meter';
import { getPool, closePool } from '../../../db/pool';
import { withTenantTransaction } from '../../../db/transaction';
import type { PoolClient } from 'pg';
import type { IObservability } from '../../observability/interfaces';

// A mock IObservability instance to test injection logic without writing to logs
const mockObservability: IObservability = {
  startSpan: jest.fn().mockReturnValue({ end: jest.fn(), setAttribute: jest.fn() }),
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
};

describe('PostgresBillingMeter', () => {
  let billingMeter: PostgresBillingMeter;

  beforeAll(() => {
    billingMeter = new PostgresBillingMeter(mockObservability);
  });

  afterAll(async () => {
    await closePool();
  });

  it('inserts a billing event successfully using the transaction helper', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000001';
    
    const pool = getPool();
    // Insert a test tenant so the foreign key constraint passes
    await pool.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Test Tenant', 'test-tenant') ON CONFLICT DO NOTHING`,
      [tenantId]
    );
    
    // Fire the emit call
    await billingMeter.emit({
      tenantId,
      eventType: 'LLM_CALL',
      quantity: 1500,
      unit: 'tokens',
      metadata: { model: 'gpt-4' },
    });

    // Validate the event was properly persisted. We must use `withTenantTransaction`
    // because `billing_events` has Row-Level Security enabled and requires the tenant parameter set!
    const res = await withTenantTransaction(tenantId, async (client: PoolClient) => {
      return client.query(
        `SELECT * FROM billing_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [tenantId]
      );
    });

    expect(res.rows.length).toBe(1);
    expect(res.rows[0].event_type).toBe('LLM_CALL');
    expect(Number(res.rows[0].quantity)).toBe(1500); // `numeric` columns in pg come back as strings sometimes, so we cast to Number
    expect(res.rows[0].unit).toBe('tokens');
    expect(res.rows[0].metadata).toEqual({ model: 'gpt-4' });
    
    // Validating IObservability metrics were triggered
    expect(mockObservability.increment).toHaveBeenCalledWith('billing.events_emitted', { type: 'LLM_CALL' });
  });
});
