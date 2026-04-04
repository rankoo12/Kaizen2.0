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
  private readonly storage: Storage | null;
  private readonly bucket: string;
  private readonly localDir: string;

  constructor(private readonly observability: IObservability) {
    this.bucket = process.env.GCS_BUCKET ?? 'kaizen-screenshots';
    this.localDir = path.resolve('./screenshots');

    const keyFile = process.env.GCS_KEY_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const hasCredentials = !!keyFile || !!process.env.GOOGLE_CLOUD_PROJECT;

    if (hasCredentials) {
      this.storage = new Storage(keyFile ? { keyFilename: keyFile } : {});
      this.observability.log('info', 'screenshot.gcs_enabled', { bucket: this.bucket });
    } else {
      this.storage = null;
      this.observability.log('info', 'screenshot.local_fallback', {
        dir: this.localDir,
        note: 'Set GCS_KEY_FILE to enable Google Cloud Storage uploads',
      });
    }
  }

  /**
   * Upload a PNG buffer to GCS or save locally.
   * Returns the object key (GCS) or file path (local) on success, null on error.
   */
  async upload(
    png: Buffer,
    tenantId: string,
    runId: string,
    stepIndex: number,
    timing: 'before' | 'after',
  ): Promise<string | null> {
    if (!png) return null;

    const key = `${tenantId}/${runId}/${stepIndex}/${timing}.png`;

    if (this.storage) {
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

    if (key.startsWith('gs://') || (this.storage && !key.startsWith('/'))) {
      return this.downloadFromGCS(key.replace(`gs://${this.bucket}/`, ''));
    }

    return this.readLocally(key);
  }

  private async downloadFromGCS(objectKey: string): Promise<Buffer | null> {
    if (!this.storage) return null;
    try {
      const [contents] = await this.storage.bucket(this.bucket).file(objectKey).download();
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
    try {
      const file = this.storage!.bucket(this.bucket).file(key);
      await file.save(png, { contentType: 'image/png', resumable: false });
      this.observability.increment('screenshot.gcs_uploaded');
      return `gs://${this.bucket}/${key}`;
    } catch (e: any) {
      this.observability.log('warn', 'screenshot.gcs_upload_failed', { key, error: e.message });
      return null;
    }
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
