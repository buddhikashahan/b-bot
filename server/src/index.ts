import { buildServer } from './api/server.js';
import { adoptCarriedPassword } from './api/system-routes.js';
import { purgeOrphanUploads } from './api/job-routes.js';
import { loadCommands } from './commands/registry.js';
import { config } from './config.js';
import { connectDatabase, prisma } from './db.js';
import { onExitRequested } from './lifecycle.js';
import { logger, scoped } from './logger.js';
import { scheduler } from './scheduler/scheduler.js';
import { loadSettings } from './settings.js';
import { sessions } from './whatsapp/session-manager.js';

const log = scoped('app');

async function main(): Promise<void> {
  await connectDatabase();
  await loadSettings();
  await adoptCarriedPassword();
  await loadCommands();

  const app = await buildServer();
  await app.listen({ host: config.host, port: config.port });
  log.info(
    config.headless
      ? `headless mode: pair in this terminal (health check on port ${config.port})`
      : config.isProduction
        ? `dashboard ready at http://localhost:${config.port}`
        : `API ready on port ${config.port} (dev dashboard: http://localhost:5173)`
  );

  let exiting = false;
  const shutdown = async (code: number) => {
    if (exiting) return;
    exiting = true;
    log.info('shutting down');
    // Never hang forever on a stuck socket or query.
    setTimeout(() => process.exit(code), 10_000).unref();
    await scheduler.stop().catch(() => {});
    await sessions.shutdown().catch(() => {});
    await app.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(code);
  };
  onExitRequested(shutdown);
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  await sessions.boot();
  await scheduler.start();
  void purgeOrphanUploads().catch(() => {});
}

// Baileys occasionally rejects promises nobody awaits (socket closed mid-query).
// Those must not take the whole bot down.
process.on('unhandledRejection', reason => {
  logger.error({ err: reason }, 'unhandled rejection');
});
process.on('uncaughtException', err => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

main().catch(err => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
