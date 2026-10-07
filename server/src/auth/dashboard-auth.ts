import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { getInternal, setInternal } from '../settings.js';
import { appSecret as secret } from './secret.js';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'bbot_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_KEY = 'adminPassword';

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

interface StoredPassword {
  salt: string;
  hash: string;
  /** Bumped on every change so existing sessions are invalidated. */
  version: number;
}

async function storedPassword(): Promise<StoredPassword | undefined> {
  const raw = await getInternal(PASSWORD_KEY);
  return raw ? (JSON.parse(raw) as StoredPassword) : undefined;
}

/** A password from the environment always wins and makes the dashboard password read-only. */
export function passwordManagedByEnv(): boolean {
  return Boolean(config.dashboardPassword);
}

export async function isSetupRequired(): Promise<boolean> {
  return !passwordManagedByEnv() && !(await storedPassword());
}

async function passwordVersion(): Promise<string> {
  if (passwordManagedByEnv()) return `env:${sign(config.dashboardPassword!).slice(0, 12)}`;
  return `db:${(await storedPassword())?.version ?? 0}`;
}

export async function setPassword(password: string): Promise<void> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  const previous = await storedPassword();
  const record: StoredPassword = {
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    version: (previous?.version ?? 0) + 1
  };
  await setInternal(PASSWORD_KEY, JSON.stringify(record));
}

export async function verifyPassword(password: string): Promise<boolean> {
  if (passwordManagedByEnv()) {
    // Compare digests so the comparison is constant-time regardless of length.
    return safeEqual(Buffer.from(sign(password)), Buffer.from(sign(config.dashboardPassword!)));
  }
  const record = await storedPassword();
  if (!record) return false;
  const hash = await scrypt(password, Buffer.from(record.salt, 'base64'), 64);
  return safeEqual(hash, Buffer.from(record.hash, 'base64'));
}

export async function issueToken(): Promise<string> {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, v: await passwordVersion() })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  if (!safeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number; v: string };
    return data.exp > Date.now() && data.v === (await passwordVersion());
  } catch {
    return false;
  }
}

/** Raw password record, so it can follow the dashboard to a newly selected database. */
export function exportPasswordRecord(): Promise<string | undefined> {
  return getInternal(PASSWORD_KEY);
}

/** Install a carried-over password record unless this database already has one. */
export async function adoptPasswordRecord(raw: string): Promise<void> {
  if (await storedPassword()) return;
  JSON.parse(raw);
  await setInternal(PASSWORD_KEY, raw);
}
