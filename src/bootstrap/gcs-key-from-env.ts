import fs from 'fs';
import os from 'os';
import path from 'path';

export function materializeGcsKeyFromEnv(): void {
  const b64 = process.env.GCS_KEY_JSON_B64;
  if (!b64) return;

  const target = path.join(os.tmpdir(), 'gcs-key.json');
  const cleaned = b64.replace(/\s+/g, '');
  const json = Buffer.from(cleaned, 'base64').toString('utf8');

  try {
    const parsed = JSON.parse(json);
    if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('BEGIN PRIVATE KEY')) {
      console.error('[gcs-key] decoded key is missing a valid PEM private_key field');
      return;
    }
    if (typeof parsed.client_email !== 'string') {
      console.error('[gcs-key] decoded key is missing client_email');
      return;
    }
  } catch (e: any) {
    console.error('[gcs-key] failed to parse decoded JSON:', e.message);
    console.error('[gcs-key] first 80 chars of decoded output:', JSON.stringify(json.slice(0, 80)));
    return;
  }

  fs.writeFileSync(target, json, { mode: 0o600 });
  process.env.GCS_KEY_FILE = target;
  console.log('[gcs-key] materialized service account to', target);
}
