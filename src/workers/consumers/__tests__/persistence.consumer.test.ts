import { handlePersistJob } from '../persistence.consumer';
import type { PersistRunEventsEvent, PersistStepResultEvent, StepResultRow } from '../../../modules/event-bus/interfaces';

const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../../../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));
// Tenant helpers route to the pool mock above — see src/db/__mocks__/transaction.ts
jest.mock('../../../db/transaction');

const obs = { log: jest.fn(), increment: jest.fn(), startSpan: jest.fn(), histogram: jest.fn() } as any;

const row: StepResultRow = {
  id: 'sr-1', tenantId: 't1', runId: 'r1', stepId: 'ts-9', stepIndex: 4,
  contentHash: 'ch', targetHash: 'th', status: 'passed',
  selectorUsed: '#btn', screenshotKey: 'gs://b/t1/r1/4/after.png', durationMs: 88,
  resolutionSource: 'llm', similarityScore: null, domCandidates: [{ kaizenId: 'k1', role: 'button', name: 'Add', selector: '#btn' }],
  llmPickedKaizenId: 'k1', tokensUsed: 42, archetypeName: null, errorType: null,
  capturedName: null, capturedValue: null, frameUrl: null,
};

const stepResultJob: PersistStepResultEvent = { kind: 'persist.step_result', row, attempt: 0 };

const runEventsJob: PersistRunEventsEvent = {
  kind: 'persist.run_events', tenantId: 't1', runId: 'r1', attempt: 0,
  rows: [
    { stepIndex: null, seq: 0, level: 'info', phase: 'run', message: 'Run started', data: { stepCount: 2 } },
    { stepIndex: 0, seq: 1, level: 'info', phase: 'resolve', message: 'step 01', data: null },
  ],
};

function freshDeps(fenceValue: string | null = null) {
  return { redis: { get: jest.fn().mockResolvedValue(fenceValue) } as any, obs };
}

describe('persistence consumer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('upserts step_results on the client-generated id (idempotent redelivery)', async () => {
    await handlePersistJob(stepResultJob, freshDeps());

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO step_results');
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(values[0]).toBe('sr-1');           // id
    expect(values[4]).toBe(4);                // step_index
    expect(values[13]).toBe(JSON.stringify(row.domCandidates));
    expect(values[20]).toBeNull();            // frame_url — main document
    expect(values).toHaveLength(21);
  });

  it('double-delivery issues the same upsert twice — single effective row', async () => {
    await handlePersistJob(stepResultJob, freshDeps());
    await handlePersistJob(stepResultJob, freshDeps());
    const [firstSql, firstValues] = mockQuery.mock.calls[0];
    const [secondSql, secondValues] = mockQuery.mock.calls[1];
    expect(secondSql).toBe(firstSql);
    expect(secondValues).toEqual(firstValues); // same id → ON CONFLICT path, not a second row
  });

  it('batch-inserts run_events with ON CONFLICT (run_id, seq) DO NOTHING', async () => {
    await handlePersistJob(runEventsJob, freshDeps());

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO run_events');
    expect(sql).toContain('ON CONFLICT (run_id, seq) DO NOTHING');
    expect(values).toHaveLength(16); // 2 events × 8 columns
    expect(values[3]).toBe(0);       // seq of first row
    expect(values[11]).toBe(1);      // seq of second row
  });

  it('skips the DB entirely for an empty run_events batch', async () => {
    await handlePersistJob({ ...runEventsJob, rows: [] }, freshDeps());
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('drops envelopes from a superseded attempt without touching the DB', async () => {
    const deps = freshDeps('3'); // current attempt is 3; envelope carries 0
    await handlePersistJob(stepResultJob, deps);
    await handlePersistJob(runEventsJob, deps);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(obs.increment).toHaveBeenCalledWith('persist_consumer.stale_dropped', { kind: 'persist.step_result' });
    expect(obs.increment).toHaveBeenCalledWith('persist_consumer.stale_dropped', { kind: 'persist.run_events' });
  });

  it('rethrows DB failures so BullMQ retries the job', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    await expect(handlePersistJob(stepResultJob, freshDeps())).rejects.toThrow('connection reset');
  });
});
