import { RunLogger } from '../run-logger';

// Mock the pg pool so flush() can be inspected without a database.
const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../../db/pool', () => ({ getPool: () => ({ query: mockQuery }) }));

const obs = { log: jest.fn(), increment: jest.fn(), startSpan: jest.fn(), histogram: jest.fn() } as any;

describe('RunLogger', () => {
  beforeEach(() => mockQuery.mockClear());

  it('does nothing on flush when no events were logged', async () => {
    const rl = new RunLogger('t1', 'r1', obs);
    await rl.flush();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('assigns monotonic seq and batches all events into one INSERT', async () => {
    const rl = new RunLogger('t1', 'r1', obs);
    rl.log('run', 'started');
    rl.log('resolve', 'step 1', { stepIndex: 0, data: { source: 'llm' } });
    rl.log('assert', 'ok', { stepIndex: 0, level: 'info' });
    await rl.flush();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO run_events');
    // 3 events × 8 columns = 24 bind params.
    expect(values).toHaveLength(24);
    // seq is 0,1,2 — at column offset 4 (1-indexed 4th) of each 8-tuple.
    expect(values[3]).toBe(0);
    expect(values[11]).toBe(1);
    expect(values[19]).toBe(2);
  });

  it('clears the buffer after flush (no double-write)', async () => {
    const rl = new RunLogger('t1', 'r1', obs);
    rl.log('run', 'a');
    await rl.flush();
    await rl.flush();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('serialises data to JSON and passes null when absent', async () => {
    const rl = new RunLogger('t1', 'r1', obs);
    rl.log('capture', 'x', { data: { name: 'selectedItem', value: 'Music 2' } });
    rl.log('run', 'y');
    await rl.flush();
    const values = mockQuery.mock.calls[0][1];
    expect(values[7]).toBe(JSON.stringify({ name: 'selectedItem', value: 'Music 2' }));
    expect(values[15]).toBeNull();
  });

  it('swallows DB errors (logging must never break a run)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const rl = new RunLogger('t1', 'r1', obs);
    rl.log('run', 'a');
    await expect(rl.flush()).resolves.toBeUndefined();
    expect(obs.log).toHaveBeenCalledWith('warn', 'run_logger.flush_failed', expect.any(Object));
  });
});
