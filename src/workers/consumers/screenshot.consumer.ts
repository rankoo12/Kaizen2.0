import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { IObservability } from '../../modules/observability/interfaces';
import type { ScreenshotService } from '../../modules/media/screenshot.service';
import type { ScreenshotJobData } from '../../modules/event-bus/interfaces';
import { isStaleAttempt } from '../../modules/event-bus/attempt-fence';
import { createRedisConnection, SCREENSHOTS_QUEUE_NAME } from '../../queue';

/**
 * Screenshot consumer — drains kaizen-screenshots, uploading staged PNG blobs
 * to GCS (or local disk) via the existing ScreenshotService, off the per-step
 * critical path. Phase 1 runs it co-located in the worker process; Phase 2
 * moves this same start function behind its own entrypoint.
 *
 * Idempotency: the storage key is deterministic per (tenant, run, step,
 * timing), so a redelivered job overwrites the same object — single effect.
 *
 * Spec: docs/specs/workers/spec-service-decomposition.md §3, §6
 */

export type ScreenshotConsumerDeps = {
  /** Non-blocking Redis connection for blob fetch + attempt fence (not the BullMQ worker connection). */
  redis: Redis;
  screenshots: ScreenshotService;
  obs: IObservability;
};

export async function handleScreenshotJob(
  data: ScreenshotJobData,
  deps: ScreenshotConsumerDeps,
): Promise<void> {
  const { redis, screenshots, obs } = deps;

  if (await isStaleAttempt(redis, data.runId, data.attempt)) {
    obs.increment('screenshot_consumer.stale_dropped');
    return;
  }

  const png = await redis.getBuffer(data.blobRef);
  if (!png || png.length === 0) {
    // Blob TTL expired before the job ran (extended outage). The step_result
    // already references the deterministic key, so /media 404s for this shot —
    // accepted eventual-consistency loss, not a retryable condition.
    obs.log('warn', 'screenshot_consumer.blob_missing', {
      blobRef: data.blobRef, runId: data.runId, stepIndex: data.stepIndex, timing: data.timing,
    });
    obs.increment('screenshot_consumer.blob_missing');
    return;
  }

  const stored = await screenshots.upload(png, data.tenantId, data.runId, data.stepIndex, data.timing);
  if (stored === null) {
    // upload() exhausted its internal retries — rethrow so BullMQ retries the
    // whole job with backoff. The blob stays staged under its TTL.
    throw new Error(`screenshot upload failed (${data.runId} step ${data.stepIndex} ${data.timing})`);
  }

  await redis.del(data.blobRef).catch(() => { /* TTL cleans up */ });
  obs.increment('screenshot_consumer.uploaded', { timing: data.timing });
}

export function startScreenshotConsumer(deps: ScreenshotConsumerDeps): Worker<ScreenshotJobData> {
  const worker = new Worker<ScreenshotJobData>(
    SCREENSHOTS_QUEUE_NAME,
    (job) => handleScreenshotJob(job.data, deps),
    {
      connection: createRedisConnection(),
      concurrency: Number(process.env.SCREENSHOT_CONSUMER_CONCURRENCY ?? 4),
    },
  );
  worker.on('failed', (job, err) => {
    deps.obs.log('warn', 'screenshot_consumer.job_failed', { jobId: job?.id, error: err.message });
  });
  return worker;
}
