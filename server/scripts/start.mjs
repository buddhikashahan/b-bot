// Launcher / supervisor.
//
// Prepares the database, then runs the server as a child process. When the
// server exits with RESTART_CODE (the dashboard asked for a restart, e.g. after
// switching databases) the whole cycle runs again, so a provider change picks
// up a freshly generated Prisma client without the container dying.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, prepareDatabase } from './prepare-db.mjs';

const RESTART_CODE = 75;
const require = createRequire(import.meta.url);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');

loadEnvFile();

let child;
let stopping = false;

function runOnce() {
  let db;
  try {
    db = prepareDatabase();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const entry = path.join(serverDir, 'dist', 'index.js');
  if (!dev && !existsSync(entry)) {
    console.error('Server build not found. Run "npm run build" first (or "npm run dev" for development).');
    process.exit(1);
  }
  const args = dev
    ? [require.resolve('tsx/cli'), 'watch', '--clear-screen=false', path.join(serverDir, 'src', 'index.ts')]
    : [entry];

  child = spawn(process.execPath, args, {
    cwd: serverDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? (dev ? 'development' : 'production'),
      DATA_DIR: db.dataDir,
      DATABASE_URL: db.url,
      BBOT_DB_PROVIDER: db.provider,
      BBOT_DB_SOURCE: db.source,
      // tsx watch owns the process in dev, so only production restarts are supervised.
      BBOT_SUPERVISED: dev ? '' : '1'
    }
  });

  child.on('exit', (code, signal) => {
    if (!stopping && code === RESTART_CODE) {
      console.log('[launcher] restart requested');
      runOnce();
      return;
    }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
}

runOnce();
