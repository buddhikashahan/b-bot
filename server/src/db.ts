import { PrismaClient } from '@prisma/client';
import { config } from './config.js';
import { scoped } from './logger.js';

const log = scoped('db');
const isSqlite = config.database.provider === 'sqlite';

function datasourceUrl(): string {
  const url = config.database.url;
  // SQLite allows one writer at a time; a single pooled connection turns
  // "database is locked" errors under concurrent writes into simple queueing.
  if (isSqlite && !url.includes('connection_limit=')) {
    return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
  }
  return url;
}

export const prisma = new PrismaClient({ datasourceUrl: datasourceUrl() });

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  if (isSqlite) {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  }
  log.info(`connected (${config.database.provider})`);
}
