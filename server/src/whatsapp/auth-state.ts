import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  useMultiFileAuthState,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap
} from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';

const log = scoped('auth');

export interface AuthStore {
  state: AuthenticationState;
  saveCreds(): Promise<void>;
  /** Persist anything still pending (called on shutdown). */
  flush(): Promise<void>;
  /** Wipe every trace of the session so the next start pairs from scratch. */
  clear(): Promise<void>;
}

export function isPaired(creds: AuthenticationCreds): boolean {
  return Boolean(creds.account && creds.me?.id);
}

export function createAuthStore(sessionId: string): Promise<AuthStore> {
  return config.authStore === 'database' ? databaseAuthStore(sessionId) : fileAuthStore(sessionId);
}

// --- AUTH_STORE=database: everything lives in the AuthKey table -------------------------------

const CREDS = 'creds';
/** Rows per statement: comfortably inside the parameter limits of all four databases. */
const WRITE_CHUNK = 200;
/** Attempts for a write that lost a race inside the database (Prisma error P2034). */
const WRITE_ATTEMPTS = 4;

function chunked<T>(items: T[], size = WRITE_CHUNK): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function keyHash(category: string, id: string): string {
  return createHash('sha256').update(`${category}:${id}`).digest('hex');
}

async function databaseAuthStore(sessionId: string): Promise<AuthStore> {
  /**
   * Replace and remove keys in one transaction of a few statements, however many keys there are.
   *
   * WhatsApp expects the 800-odd pre-keys of a freshly linked device within 30 seconds. Written
   * one row per round trip, that takes minutes against a hosted database, the upload is
   * abandoned and the session never becomes usable. Deleting the old rows and inserting the
   * new ones in bulk costs the same handful of round trips for one key or a thousand.
   */
  const apply = async (rows: { hash: string; category: string; keyId: string; value: string }[], removed: string[]) => {
    const hashes = [...removed, ...rows.map(row => row.hash)];
    if (hashes.length === 0) return;
    for (let attempt = 1; ; attempt++) {
      try {
        await prisma.$transaction([
          ...chunked(hashes).map(part => prisma.authKey.deleteMany({ where: { sessionId, hash: { in: part } } })),
          ...chunked(rows).map(part => prisma.authKey.createMany({ data: part.map(row => ({ sessionId, ...row })) }))
        ]);
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2034' || attempt >= WRITE_ATTEMPTS) throw err;
        await new Promise(resolve => setTimeout(resolve, 50 * attempt));
      }
    }
  };

  // One write at a time, in the order they were asked for: the newest value of a key must be
  // the one that stays, and two transactions never fight over the same rows.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (rows: Parameters<typeof apply>[0], removed: string[]): Promise<void> => {
    const done = queue.then(() => apply(rows, removed));
    queue = done.catch(() => {});
    return done;
  };
  const row = (category: string, keyId: string, data: unknown) => ({
    hash: keyHash(category, keyId),
    category,
    keyId,
    value: JSON.stringify(data, BufferJSON.replacer)
  });

  const credsRow = await prisma.authKey.findUnique({
    where: { sessionId_hash: { sessionId, hash: keyHash(CREDS, CREDS) } }
  });
  const creds: AuthenticationCreds = credsRow ? JSON.parse(credsRow.value, BufferJSON.reviver) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const rows = await prisma.authKey.findMany({
            where: { sessionId, hash: { in: ids.map(id => keyHash(type, id)) } }
          });
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const row of rows) {
            let value = JSON.parse(row.value, BufferJSON.reviver);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            result[row.keyId] = value;
          }
          return result;
        },
        async set(data: SignalDataSet) {
          const rows: Parameters<typeof apply>[0] = [];
          const removed: string[] = [];
          for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              if (value) rows.push(row(category, id, value));
              else removed.push(keyHash(category, id));
            }
          }
          await enqueue(rows, removed);
        }
      }
    },
    async saveCreds() {
      await enqueue([row(CREDS, CREDS, creds)], []);
    },
    async flush() {
      await queue;
    },
    async clear() {
      await queue;
      await prisma.authKey.deleteMany({ where: { sessionId } });
    }
  };
}

// --- AUTH_STORE=file: Baileys' multi-file store, mirrored into the database -------------------
//
// The files are the live store; the AuthFileBackup table is a copy that lets a
// container with a lost/empty volume pick the session back up without re-pairing.

const BACKUP_DEBOUNCE_MS = 30_000;

async function fileAuthStore(sessionId: string): Promise<AuthStore> {
  const dir = path.join(config.paths.sessions, sessionId);

  if (!existsSync(path.join(dir, 'creds.json'))) {
    const rows = await prisma.authFileBackup.findMany({ where: { sessionId } });
    if (rows.length) {
      await mkdir(dir, { recursive: true });
      await Promise.all(rows.map(row => writeFile(path.join(dir, path.basename(row.file)), row.content)));
      log.info(`restored ${rows.length} auth files for "${sessionId}" from the database backup`);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(dir);

  let timer: NodeJS.Timeout | undefined;
  let lastSync = 0;
  let syncing = false;
  let cleared = false;

  const schedule = () => {
    if (timer || cleared) return;
    timer = setTimeout(() => {
      timer = undefined;
      void sync().catch(err => log.warn({ err }, 'auth backup failed'));
    }, BACKUP_DEBOUNCE_MS);
    timer.unref();
  };

  const sync = async () => {
    if (cleared) return;
    if (syncing) return schedule();
    syncing = true;
    try {
      const startedAt = Date.now();
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const file of files) {
        const info = await stat(path.join(dir, file)).catch(() => undefined);
        // Only re-upload what changed since the previous pass (1s slack for coarse mtimes).
        if (!info?.isFile() || info.mtimeMs < lastSync - 1000) continue;
        const content = await readFile(path.join(dir, file), 'utf8').catch(() => undefined);
        if (content === undefined) continue;
        await prisma.authFileBackup.upsert({
          where: { sessionId_file: { sessionId, file } },
          create: { sessionId, file, content },
          update: { content }
        });
      }
      const present = new Set(files);
      const rows = await prisma.authFileBackup.findMany({ where: { sessionId }, select: { id: true, file: true } });
      const stale = rows.filter(row => !present.has(row.file)).map(row => row.id);
      if (stale.length) await prisma.authFileBackup.deleteMany({ where: { id: { in: stale } } });
      lastSync = startedAt;
    } finally {
      syncing = false;
    }
  };

  const keys = state.keys;
  return {
    state: {
      creds: state.creds,
      keys: {
        get: (type, ids) => keys.get(type, ids),
        async set(data) {
          await keys.set(data);
          schedule();
        }
      }
    },
    async saveCreds() {
      await saveCreds();
      schedule();
    },
    async flush() {
      clearTimeout(timer);
      timer = undefined;
      await sync();
    },
    async clear() {
      cleared = true;
      clearTimeout(timer);
      await rm(dir, { recursive: true, force: true });
      await prisma.authFileBackup.deleteMany({ where: { sessionId } });
    }
  };
}
