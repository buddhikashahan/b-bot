import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from '../config.js';

// The instance secret: signs dashboard login cookies and encrypts credentials
// (such as the AI API key) before they are written to the database.
// It comes from APP_SECRET, or is generated once and kept in data/secret.key.

function loadSecret(): Buffer {
  if (config.appSecret) return Buffer.from(config.appSecret);
  if (existsSync(config.paths.secret)) return readFileSync(config.paths.secret);
  const secret = randomBytes(48);
  writeFileSync(config.paths.secret, secret, { mode: 0o600 });
  return secret;
}

export const appSecret = loadSecret();

const SEALED_PREFIX = 'enc:v1:';
/** A separate key for encryption, so it is never the same bytes that sign cookies. */
const sealingKey = createHash('sha256').update(appSecret).update('b-bot/sealed-values/v1').digest();

export function isSealed(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX);
}

/** Encrypt a value for storage (AES-256-GCM). Someone with only the database cannot read it. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/**
 * Decrypt a stored value.
 * @returns the plain text, or undefined when it was sealed with a different secret
 *          (APP_SECRET changed, or data/secret.key was lost) or has been tampered with
 */
export function unseal(stored: string): string | undefined {
  if (!isSealed(stored)) return stored;
  try {
    const raw = Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', sealingKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}
