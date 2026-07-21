import { Storage } from '@google-cloud/storage';
import fs from 'fs';
import path from 'path';
import type { IObservability } from '../observability/interfaces';

/**
 * ScreenshotService — Phase 3
 *
 * Uploads PNG buffers to Google Cloud Storage (GCS).
 * Falls back to local disk (./screenshots/) when GCS is not configured,
 * so development works without cloud credentials.
 *
 * Key format: {tenantId}/{runId}/{stepIndex}/{before|after}.png
 *
 * Before/after screenshots are stored for:
 *  - Human review of test outcomes
 *  - FailureClassifier Signal C (pixelmatch diff)
 *  - Future: LLM visual verification (Phase 5)
 *
 * GCS env vars:
 *   GCS_BUCKET              — bucket name (default: kaizen-screenshots)
 *   GCS_KEY_FILE            — path to service account JSON key file
 *   GOOGLE_APPLICATION_CREDENTIALS — alternative to GCS_KEY_FILE
 */
export class ScreenshotService {
  private readonly bucket: string;
  private readonly localDir: string;
  private readonly keyFile: string | undefined;
  private readonly gcsEnabled: boolean;

  // Process-local LRU of downloaded PNG buffers. Screenshots are immutable per
  // key, so caching them lets repeat downloads (e.g. many viewers of the same
  // run, or a client bypassing its HTTP cache) skip the GCS/disk round-trip —
  // capping egress cost and shielding the endpoint from download-flood abuse.
  // Bounded by both entry count and total bytes; oldest entries evict first.
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private readonly maxCacheEntries = Number(process.env.SCREENSHOT_CACHE_MAX_ENTRIES ?? 256);
  private readonly maxCacheBytes = Number(process.env.SCREENSHOT_CACHE_MAX_BYTES ?? 128 * 1024 * 1024);

  constructor(private readonly observability: IObservability) {
    this.bucket = process.env.GCS_BUCKET ?? 'kaizen-screenshots';
    this.localDir = path.resolve('./screenshots');

    this.keyFile = process.env.GCS_KEY_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    this.gcsEnabled = !!this.keyFile || !!process.env.GOOGLE_CLOUD_PROJECT;

    if (this.gcsEnabled) {
      this.observability.log('info', 'screenshot.gcs_enabled', { bucket: this.bucket });
    } else {
      this.observability.log('info', 'screenshot.local_fallback', {
        dir: this.localDir,
        note: 'Set GCS_KEY_FILE to enable Google Cloud Storage uploads',
      });
    }
  }

  private newStorage(): Storage {
    return new Storage(this.keyFile ? { keyFilename: this.keyFile } : {});
  }

  /**
   * Upload a PNG buffer to GCS or save locally.
   * Returns the object key (GCS) or file path (local) on success, null on error.
   */
  async upload(
    png: Buffer | null | undefined,
    tenantId: string,
    runId: string,
    stepIndex: number,
    timing: 'before' | 'after',
  ): Promise<string | null> {
    if (!png || !Buffer.isBuffer(png) || png.length === 0) return null;

    const key = `${tenantId}/${runId}/${stepIndex}/${timing}.png`;

    if (this.gcsEnabled) {
      return this.uploadToGCS(png, key);
    }

    return this.saveLocally(png, key);
  }

  /**
   * Download a PNG from GCS or local disk by its key.
   * Used to fetch the last-known-good screenshot for Signal C classification.
   * Returns null if the key is a GCS path but GCS is not configured, or on error.
   */
  async download(key: string): Promise<Buffer | null> {
    if (!key) return null;

    const cached = this.cacheGet(key);
    if (cached) {
      this.observability.increment('screenshot.cache_hit');
      return cached;
    }

    let buffer: Buffer | null;
    if (key.startsWith('gs://') || (this.gcsEnabled && !key.startsWith('/'))) {
      buffer = await this.downloadFromGCS(key.replace(`gs://${this.bucket}/`, ''));
    } else {
      buffer = this.readLocally(key);
    }

    if (buffer) this.cacheSet(key, buffer);
    return buffer;
  }

  /** LRU read: returns the cached buffer and marks it most-recently-used. */
  private cacheGet(key: string): Buffer | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  /** LRU write: inserts, then evicts oldest entries until within bounds. */
  private cacheSet(key: string, buf: Buffer): void {
    if (buf.length > this.maxCacheBytes) return; // single item too large to cache
    const existing = this.cache.get(key);
    if (existing) {
      this.cacheBytes -= existing.length;
      this.cache.delete(key);
    }
    this.cache.set(key, buf);
    this.cacheBytes += buf.length;
    while (this.cache.size > this.maxCacheEntries || this.cacheBytes > this.maxCacheBytes) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cacheBytes -= this.cache.get(oldest)!.length;
      this.cache.delete(oldest);
    }
  }

  private async downloadFromGCS(objectKey: string): Promise<Buffer | null> {
    if (!this.gcsEnabled) return null;
    try {
      const [contents] = await this.newStorage().bucket(this.bucket).file(objectKey).download();
      return contents;
    } catch (e: any) {
      this.observability.log('warn', 'screenshot.gcs_download_failed', { objectKey, error: e.message });
      return null;
    }
  }

  private readLocally(filePath: string): Buffer | null {
    try {
      return fs.readFileSync(filePath);
    } catch (e: any) {
      this.observability.log('warn', 'screenshot.local_read_failed', { filePath, error: e.message });
      return null;
    }
  }

  private async uploadToGCS(png: Buffer, key: string): Promise<string | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.writeOnce(png, key);
        this.observability.increment('screenshot.gcs_uploaded');
        return `gs://${this.bucket}/${key}`;
      } catch (e: any) {
        const retriable = /stream was destroyed|ECONNRESET|ETIMEDOUT|socket hang up|key must be/i.test(e.message ?? '');
        if (!retriable || attempt === 3) {
          this.observability.log('warn', 'screenshot.gcs_upload_failed', { key, attempt, error: e.message });
          return null;
        }
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
    return null;
  }

  private writeOnce(png: Buffer, key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = this.newStorage().bucket(this.bucket).file(key);
      const stream = file.createWriteStream({
        contentType: 'image/png',
        resumable: false,
        validation: false,
        metadata: { contentType: 'image/png' },
      });
      stream.once('error', reject);
      stream.once('finish', resolve);
      stream.end(png);
    });
  }

  private async saveLocally(png: Buffer, key: string): Promise<string | null> {
    try {
      const filePath = path.join(this.localDir, key);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, png);
      this.observability.increment('screenshot.local_saved');
      return filePath;
    } catch (e: any) {
      this.observability.log('warn', 'screenshot.local_save_failed', { key, error: e.message });
      return null;
    }
  }
}
