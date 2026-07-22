import { handleScreenshotJob } from '../screenshot.consumer';
import type { ScreenshotJobData } from '../../../modules/event-bus/interfaces';

const obs = { log: jest.fn(), increment: jest.fn(), startSpan: jest.fn(), histogram: jest.fn() } as any;

const job: ScreenshotJobData = {
  kind: 'screenshot.upload', tenantId: 't1', runId: 'r1', stepIndex: 2,
  timing: 'after', blobRef: 'kzn:shot:r1:2:after:0', attempt: 0,
};

function freshDeps(opts: { fence?: string | null; blob?: Buffer | null; stored?: string | null } = {}) {
  const redis = {
    get: jest.fn().mockResolvedValue(opts.fence ?? null),
    getBuffer: jest.fn().mockResolvedValue(opts.blob === undefined ? Buffer.from('png') : opts.blob),
    del: jest.fn().mockResolvedValue(1),
  } as any;
  const screenshots = {
    upload: jest.fn().mockResolvedValue(opts.stored === undefined ? 'gs://b/t1/r1/2/after.png' : opts.stored),
  } as any;
  return { redis, screenshots, obs };
}

describe('screenshot consumer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches the staged blob, uploads it, and deletes the blob', async () => {
    const deps = freshDeps();
    await handleScreenshotJob(job, deps);

    expect(deps.redis.getBuffer).toHaveBeenCalledWith(job.blobRef);
    expect(deps.screenshots.upload).toHaveBeenCalledWith(expect.any(Buffer), 't1', 'r1', 2, 'after');
    expect(deps.redis.del).toHaveBeenCalledWith(job.blobRef);
    expect(obs.increment).toHaveBeenCalledWith('screenshot_consumer.uploaded', { timing: 'after' });
  });

  it('treats an expired blob as a permanent (non-retryable) miss', async () => {
    const deps = freshDeps({ blob: null });
    await expect(handleScreenshotJob(job, deps)).resolves.toBeUndefined();

    expect(deps.screenshots.upload).not.toHaveBeenCalled();
    expect(obs.log).toHaveBeenCalledWith('warn', 'screenshot_consumer.blob_missing', expect.any(Object));
  });

  it('throws when upload exhausts its internal retries — BullMQ retries the job', async () => {
    const deps = freshDeps({ stored: null });
    await expect(handleScreenshotJob(job, deps)).rejects.toThrow('screenshot upload failed');
    expect(deps.redis.del).not.toHaveBeenCalled(); // blob must survive for the retry
  });

  it('drops jobs from a superseded attempt before fetching anything', async () => {
    const deps = freshDeps({ fence: '2' });
    await handleScreenshotJob(job, deps);

    expect(deps.redis.getBuffer).not.toHaveBeenCalled();
    expect(deps.screenshots.upload).not.toHaveBeenCalled();
    expect(obs.increment).toHaveBeenCalledWith('screenshot_consumer.stale_dropped');
  });
});
