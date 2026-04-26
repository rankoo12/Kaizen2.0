import { getPool } from '../../db/pool';

export async function usageThisMonth(tenantId: string): Promise<number> {
  const { rows } = await getPool().query<{ total: string }>(
    `SELECT COALESCE(SUM(quantity), 0)::text AS total
     FROM billing_events
     WHERE tenant_id = $1
       AND event_type = 'LLM_CALL'
       AND created_at >= date_trunc('month', now())`,
    [tenantId],
  );
  return Number(rows[0]?.total ?? 0);
}
