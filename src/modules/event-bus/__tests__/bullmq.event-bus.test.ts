import { BullMQEventBus, screenshotBlobKey } from '../bullmq.event-bus';
import type { PersistStepResultEvent, ScreenshotUploadEvent, StepResultRow } from '../interfaces';

const obs = { log: jest.fn(), increment: jest.fn(), startSpan: jest.fn(), histogram: jest.fn() } as any;

const row: StepResultRow = {
  id: 'sr-1', tenantId: 't1', runId: 'r1', stepId: null, stepIndex: 0,
  contentHash: 'ch', targetHash: 'th', status: 'passed',
  selectorUsed: '#a', screenshotKey: 'gs://b/k', durationMs: 12,
  resolutionSource: null, similarityScore: null, domCandidates: null,
  llmPickedKaizenId: null, tokensUsed: 0, archetypeName: null, errorType: null,
  capturedName: null, capturedValue: null,
};

function makeBus() {
  const redis = { set: jest.fn().mockResolvedValue('OK') } as any;
  const screenshots = { add: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) } as any;
  const persist = { add: jest.fn().mockResolvedValue(undefined), close: jest.fn().mockResolvedValue(undefined) } as any;
  const bus = new BullMQEventBus(redis, obs, { screenshots, persist });
  return { bus, redis, screenshots, persist };
}

const shot: ScreenshotUploadEvent = {
  kind: 'screenshot.upload', tenantId: 't1', runId: 'r1', stepIndex: 3,
  timing: 'after', png: Buffer.from('png-bytes'), attempt: 0,
};

describe('BullMQEventBus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stages screenshot bytes in Redis and enqueues only the blob ref', async () => {
    const { bus, redis, screenshots, persist } = makeBus();
    await bus.publish(shot);

    const expectedKey = screenshotBlobKey(shot);
    expect(redis.set).toHaveBeenCalledWith(expectedKey, shot.png, 'EX', expect.any(Number));

    expect(screenshots.add).toHaveBeenCalledTimes(1);
    const [name, payload] = screenshots.add.mock.calls[0];
    expect(name).toBe('screenshot.upload');
    expect(payload.blobRef).toBe(expectedKey);
    expect(payload).not.toHaveProperty('png'); // bytes must never ride the job payload
    expect(payload).toMatchObject({ tenantId: 't1', runId: 'r1', stepIndex: 3, timing: 'after', attempt: 0 });
    expect(persist.add).not.toHaveBeenCalled();
  });

  it('blob key is deterministic per (run, step, timing, attempt)', () => {
    expect(screenshotBlobKey(shot)).toBe(screenshotBlobKey({ ...shot }));
    expect(screenshotBlobKey(shot)).not.toBe(screenshotBlobKey({ ...shot, attempt: 1 }));
    expect(screenshotBlobKey(shot)).not.toBe(screenshotBlobKey({ ...shot, timing: 'before' }));
  });

  it('routes persist envelopes to the persist queue verbatim', async () => {
    const { bus, screenshots, persist } = makeBus();
    const e: PersistStepResultEvent = { kind: 'persist.step_result', row, attempt: 1 };
    await bus.publish(e);

    expect(persist.add).toHaveBeenCalledWith('persist.step_result', e);
    expect(screenshots.add).not.toHaveBeenCalled();
  });

  it('never rejects when the underlying queue fails (fire-and-forget contract)', async () => {
    const { bus, persist } = makeBus();
    persist.add.mockRejectedValueOnce(new Error('redis gone'));

    await expect(
      bus.publish({ kind: 'persist.step_result', row, attempt: 0 }),
    ).resolves.toBeUndefined();
    expect(obs.log).toHaveBeenCalledWith('warn', 'event_bus.publish_failed', expect.objectContaining({ kind: 'persist.step_result' }));
    expect(obs.increment).toHaveBeenCalledWith('event_bus.publish_failed', { kind: 'persist.step_result' });
  });

  it('never rejects when blob staging fails', async () => {
    const { bus, redis, screenshots } = makeBus();
    redis.set.mockRejectedValueOnce(new Error('OOM'));

    await expect(bus.publish(shot)).resolves.toBeUndefined();
    expect(screenshots.add).not.toHaveBeenCalled(); // no job pointing at a blob that was never staged
  });

  it('close() closes both queues', async () => {
    const { bus, screenshots, persist } = makeBus();
    await bus.close();
    expect(screenshots.close).toHaveBeenCalled();
    expect(persist.close).toHaveBeenCalled();
  });
});
