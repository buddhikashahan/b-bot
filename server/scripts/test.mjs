// Test runner. Every suite in server/test gets its own throwaway data folder and
// SQLite database, so tests never touch a real installation.
//
//   npm test              offline suites
//   npm test -- --live    also the suites that need internet (public APIs, yt-dlp)
//   npm test -- core      only suites whose file name contains "core"
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDatabase } from './prepare-db.mjs';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(serverDir, 'test');
const args = process.argv.slice(2);
const live = args.includes('--live');
const filters = args.filter(arg => !arg.startsWith('--'));

const suites = readdirSync(testDir)
  .filter(file => file.endsWith('.test.mts'))
  .filter(file => live || !file.includes('.live.'))
  .filter(file => filters.length === 0 || filters.some(filter => file.includes(filter)))
  .sort();
if (suites.length === 0) {
  console.error('No test suite matches.');
  process.exit(1);
}

// Tests always run against their own SQLite file, whatever this machine is configured to use.
delete process.env.DATABASE_URL;
const failed = [];
for (const suite of suites) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bbot-test-'));
  process.env.DATA_DIR = dataDir;
  try {
    const db = prepareDatabase();
    console.log(`\n=== ${suite} ===`);
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(testDir, suite)], {
      cwd: serverDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        LOG_LEVEL: 'fatal',
        DATA_DIR: dataDir,
        DATABASE_URL: db.url,
        BBOT_DB_PROVIDER: db.provider,
        BBOT_DB_SOURCE: 'default',
        ...(live ? { BBOT_LIVE_TESTS: '1' } : {})
      }
    });
    if (result.status !== 0) failed.push(suite);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

console.log(failed.length ? `\n${failed.length} of ${suites.length} suite(s) failed: ${failed.join(', ')}` : `\nAll ${suites.length} suite(s) passed.`);
process.exit(failed.length ? 1 : 0);
