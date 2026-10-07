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

function keyHash(category: string, id: string): string {
  return createHash('sha256').update(`${category}:${id}`).digest('hex');
}

async function databaseAuthStore(sessionId: string): Promise<AuthStore> {
  const write = (category: string, keyId: string, data: unknown) => {
    const hash = keyHash(category, keyId);
    const value = JSON.stringify(data, BufferJSON.replacer);
    return prisma.authKey.upsert({
      where: { sessionId_hash: { sessionId, hash } },
      create: { sessionId, hash, category, keyId, value },
      update: { value }
    });
  };

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
          const ops = [];
          for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
            const entries = data[category] ?? {};
            for (const [id, value] of Object.entries(entries)) {
              ops.push(
                value
                  ? write(category, id, value)
                  : prisma.authKey.deleteMany({ where: { sessionId, hash: keyHash(category, id) } })
              );
            }
          }
          if (ops.length) await prisma.$transaction(ops);
        }
      }
    },
    async saveCreds() {
      await write(CREDS, CREDS, creds);
    },
    async flush() {},
    async clear() {
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
