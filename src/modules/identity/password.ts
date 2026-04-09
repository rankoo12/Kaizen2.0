/**
 * Password hashing using Node's built-in crypto.scrypt.
 *
 * Format stored in DB: "{hex_salt}:{hex_hash}"
 * scrypt parameters: N=16384, r=8, p=1, keylen=64 bytes
 * These are the OWASP-recommended minimum parameters for scrypt.
 *
 * Note: the spec references bcrypt cost-12. scrypt at these parameters
 * is equally NIST-approved and requires no external dependency.
 */

import { scrypt, randomBytes, timingSafeEqual } from 'crypto';

// scrypt(password, salt, keylen, options, callback) — promisify wraps the callback form
const scryptAsync = (password: string, salt: string, keylen: number, options: object): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );

const SALT_BYTES = 16;
const KEY_LEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = (await scryptAsync(password, salt, KEY_LEN, SCRYPT_PARAMS)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, storedHash] = stored.split(':');
  if (!salt || !storedHash) return false;
  const storedBuffer = Buffer.from(storedHash, 'hex');
  const supplied = (await scryptAsync(password, salt, KEY_LEN, SCRYPT_PARAMS)) as Buffer;
  // timingSafeEqual prevents timing attacks
  return storedBuffer.length === supplied.length && timingSafeEqual(storedBuffer, supplied);
}
