import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { IObservability } from '../observability/interfaces';
import { createPersistQueue, createScreenshotQueue } from '../../queue';
import type {
  IEventBus,
  PersistJobData,
  RunEventEnvelope,
  ScreenshotJobData,
  ScreenshotUploadEvent,
} from './interfaces';

/**
 * BullMQEventBus — default IEventBus over the two side-effect queues.
 * Spec: docs/specs/workers/spec-service-decomposition.md §5
 *
 * PNG transport: screenshot payloads are staged as raw bytes in a TTL-bounded
 * Redis key; the job carries only the ref. Inline Buffers JSON-serialise to
 * ~4x their size and would sit in Redis for the lifetime of removeOnComplete's
 * retention window — staging keeps job payloads O(100 bytes) and blobs are
 * deleted by the consumer on upload (TTL is the backstop).
 */

/** Must comfortably cover the screenshot queue's full retry/backoff window. */
const BLOB_TTL_SECONDS = Number(process.env.SCREENSHOT_BLOB_TTL_SECONDS ?? 600);

/**
 * Deterministic per (run, step, timing, attempt): a re-published event
 * overwrites its own blob, never another attempt's.
 */
export function screenshotBlobKey(
  e: Pick<ScreenshotUploadEvent, 'runId' | 'stepIndex' | 'timing' | 'attempt'>,
): string {
  return `kzn:shot:${e.runId}:${e.stepIndex}:${e.timing}:${e.attempt}`;
}

export class BullMQEventBus implements IEventBus {
  private readonly screenshotQueue: Queue<ScreenshotJobData>;
  private readonly persistQueue: Queue<PersistJobData>;

  constructor(
    private readonly redis: Redis,
    private readonly obs: IObservability,
    queues?: { screenshots: Queue<ScreenshotJobData>; persist: Queue<PersistJobData> },
  ) {
    this.screenshotQueue = queues?.screenshots ?? createScreenshotQueue();
    this.persistQueue = queues?.persist ?? createPersistQueue();
    // Queues emit 'error' on Redis connection blips; without a listener that is
    // an unhandled EventEmitter error and kills the process. publish() already
    // degrades gracefully per call — these only need to observe.
    this.screenshotQueue.on('error', (err) =>
      this.obs.log('warn', 'event_bus.queue_error', { queue: 'screenshots', error: err.message }));
    this.persistQueue.on('error', (err) =>
      this.obs.log('warn', 'event_bus.queue_error', { queue: 'persist', error: err.message }));
  }

  async publish(e: RunEventEnvelope): Promise<void> {
    try {
      if (e.kind === 'screenshot.upload') {
        const { png, ...meta } = e;
        const blobRef = screenshotBlobKey(e);
        await this.redis.set(blobRef, png, 'EX', BLOB_TTL_SECONDS);
        await this.screenshotQueue.add(e.kind, { ...meta, blobRef });
      } else {
        await this.persistQueue.add(e.kind, e);
      }
      this.obs.increment('event_bus.published', { kind: e.kind });
    } catch (err: any) {
      // Fire-and-forget by contract: a bus outage degrades side-effects but
      // must never throw into the step loop.
      this.obs.log('warn', 'event_bus.publish_failed', { kind: e.kind, error: err.message });
      this.obs.increment('event_bus.publish_failed', { kind: e.kind });
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.screenshotQueue.close(), this.persistQueue.close()]);
  }
}
