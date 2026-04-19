import fs from 'fs';
import os from 'os';
import path from 'path';

export function materializeGcsKeyFromEnv(): void {
  const b64 = process.env.GCS_KEY_JSON_B64;
  if (!b64) return;

  const target = path.join(os.tmpdir(), 'gcs-key.json');
  const json = Buffer.from(b64, 'base64').toString('utf8');
  fs.writeFileSync(target, json, { mode: 0o600 });

  process.env.GCS_KEY_FILE = target;
}
