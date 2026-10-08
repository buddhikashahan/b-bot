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
    // The client is generated for whichever database is configured when the server is built,
    // and the one for MongoDB has no raw SQL methods. Hence the cast: this must compile for all of them.
    const sql = prisma as unknown as { $queryRawUnsafe(query: string): Promise<unknown> };
    await sql.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await sql.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  }
  log.info(`connected (${config.database.provider})`);
}
