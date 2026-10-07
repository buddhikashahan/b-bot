import { readFileSync, writeFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adoptPasswordRecord, exportPasswordRecord } from '../auth/dashboard-auth.js';
import { RESTART_EXIT_CODE, config } from '../config.js';
import { prisma } from '../db.js';
import { requestExit } from '../lifecycle.js';
import { recentLogs, scoped } from '../logger.js';
import { conflict } from './http.js';

const log = scoped('system');

const DatabaseSchema = z.object({
  /** null switches back to the bundled SQLite file. */
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^(file:|postgres(ql)?:\/\/|mysql:\/\/|mongodb(\+srv)?:\/\/).+/i, 'Use a file:, postgresql://, mysql:// or mongodb:// URL.')
    .nullable()
});

/** data/bbot.config.json, shared with scripts/prepare-db.mjs. */
export interface RuntimeConfig {
  databaseUrl?: string;
  databaseError?: string;
  /** Dashboard password record in transit to a newly selected database. */
  adminPassword?: string;
}

export function readRuntimeConfig(): RuntimeConfig {
  try {
    return JSON.parse(readFileSync(config.paths.runtimeConfig, 'utf8')) as RuntimeConfig;
  } catch {
    return {};
  }
}

export function writeRuntimeConfig(runtime: RuntimeConfig): void {
  writeFileSync(config.paths.runtimeConfig, JSON.stringify(runtime, null, 2), { mode: 0o600 });
}

/**
 * After a database switch the new database is empty. Bring the dashboard
 * password along so the instance never reopens as "first visitor sets the password".
 */
export async function adoptCarriedPassword(): Promise<void> {
  const runtime = readRuntimeConfig();
  if (!runtime.adminPassword) return;
  await adoptPasswordRecord(runtime.adminPassword).catch(err => log.warn({ err }, 'could not carry the password over'));
  delete runtime.adminPassword;
  writeRuntimeConfig(runtime);
}

function maskUrl(url: string): string {
  return url.replace(/(:\/\/[^:/@]+):[^@]*@/, '$1:***@');
}

function restartSoon(): void {
  // Give the HTTP response time to flush before the process goes away.
  setTimeout(() => requestExit(RESTART_EXIT_CODE), 500);
}

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get('/api/system', async () => {
    const runtime = readRuntimeConfig();
    const [cachedMessages, contacts, jobs] = await Promise.all([
      prisma.cachedMessage.count(),
      prisma.contact.count(),
      prisma.scheduledJob.count()
    ]);
    return {
      version: config.version,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeSeconds: Math.round(process.uptime()),
      authStore: config.authStore,
      supervised: config.supervised,
      database: {
        provider: config.database.provider,
        source: config.database.source,
        url: maskUrl(config.database.url),
        /** Set when the database saved in the dashboard was rejected on the last boot. */
        error: runtime.databaseError,
        rejectedUrl: runtime.databaseError && runtime.databaseUrl ? maskUrl(runtime.databaseUrl) : undefined
      },
      stats: { cachedMessages, contacts, jobs }
    };
  });

  /**
   * Point B-Bot at another database. The choice is written to the runtime
   * config file and applied by the launcher (schema render, client generation,
   * table sync) on the next start.
   */
  app.post('/api/system/database', async req => {
    if (config.database.source === 'env') {
      throw conflict('DATABASE_URL is set in the environment, so the database cannot be changed from the dashboard.');
    }
    const { url } = DatabaseSchema.parse(req.body);
    const runtime = readRuntimeConfig();
    delete runtime.databaseError;
    if (url) runtime.databaseUrl = url;
    else delete runtime.databaseUrl;
    runtime.adminPassword = await exportPasswordRecord();
    writeRuntimeConfig(runtime);
    log.info(url ? 'database changed from the dashboard' : 'database reset to the bundled SQLite file');
    if (config.supervised) restartSoon();
    return { restarting: config.supervised };
  });

  app.post('/api/system/restart', async () => {
    if (!config.supervised) {
      throw conflict('Automatic restart is only available under "npm start" or Docker. Restart the process manually.');
    }
    log.info('restart requested from the dashboard');
    restartSoon();
    return { restarting: true };
  });

  app.get('/api/logs', async () => recentLogs());
}
