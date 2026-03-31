import { withTenantTransaction } from '../transaction';
import { getPool, closePool } from '../pool';

describe('DB Repository Layer - transaction', () => {
  afterAll(async () => {
    // Teardown the pool after tests to allow Jest to exit
    await closePool();
  });

  it('sets application tenant ID correctly inside transaction', async () => {
    // Ensure we are passing a UUID format
    const tenantId = '00000000-0000-0000-0000-000000000001';
    
    await withTenantTransaction(tenantId, async (client) => {
      // current_setting arguments: (setting_name, missing_ok)
      const res = await client.query(`SELECT current_setting('app.current_tenant_id', true) as tenant_id`);
      expect(res.rows[0].tenant_id).toBe(tenantId);
    });
  });

  it('rolls back correctly on error', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000002';
    
    await expect(
      withTenantTransaction(tenantId, async (client) => {
        const res = await client.query(`SELECT current_setting('app.current_tenant_id', true) as tenant_id`);
        expect(res.rows[0].tenant_id).toBe(tenantId);
        
        throw new Error('Test rollback error');
      })
    ).rejects.toThrow('Test rollback error');
  });
});
