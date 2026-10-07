// Resolves which database to use, renders prisma/schema.prisma for that
// provider, regenerates the Prisma client when the schema changed, and syncs
// the tables with `prisma db push`.
//
// Used by scripts/start.mjs on every boot and directly as `npm run db:prepare`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const rootDir = path.resolve(serverDir, '..');
const prismaDir = path.join(serverDir, 'prisma');
const templatePath = path.join(prismaDir, 'schema.template.prisma');
const schemaPath = path.join(prismaDir, 'schema.prisma');
const markerPath = path.join(prismaDir, '.generated');

export function loadEnvFile() {
  const envPath = path.join(rootDir, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

export function resolveDataDir() {
  return path.resolve(rootDir, process.env.DATA_DIR || 'data');
}

export function detectProvider(url) {
  if (/^file:/i.test(url)) return 'sqlite';
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgresql';
  if (/^mysql:\/\//i.test(url)) return 'mysql';
  if (/^mongodb(\+srv)?:\/\//i.test(url)) return 'mongodb';
  throw new Error(
    `Unsupported DATABASE_URL scheme. Expected file:, postgresql://, mysql:// or mongodb://, got "${url.split(':')[0]}:"`
  );
}

function defaultSqliteUrl(dataDir) {
  return `file:${path.join(dataDir, 'bbot.db').replaceAll('\\', '/')}`;
}

function runtimeConfigPath(dataDir) {
  return path.join(dataDir, 'bbot.config.json');
}

export function readRuntimeConfig(dataDir) {
  try {
    return JSON.parse(readFileSync(runtimeConfigPath(dataDir), 'utf8'));
  } catch {
    return {};
  }
}

export function writeRuntimeConfig(dataDir, config) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(runtimeConfigPath(dataDir), JSON.stringify(config, null, 2));
}

/** DATABASE_URL from the environment wins, then the dashboard's saved choice, then SQLite. */
export function resolveDatabase(dataDir) {
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, source: 'env' };
  }
  const saved = readRuntimeConfig(dataDir).databaseUrl;
  if (saved) return { url: saved, source: 'config' };
  return { url: defaultSqliteUrl(dataDir), source: 'default' };
}

export function renderSchema(provider) {
  return readFileSync(templatePath, 'utf8')
    .replaceAll('__PROVIDER__', provider)
    .replaceAll('__ID__', provider === 'mongodb' ? '@map("_id")' : '')
    .replaceAll('__TEXT__', provider === 'mysql' ? '@db.LongText' : '')
    .replace(/[ \t]+$/gm, '');
}

function prisma(args, databaseUrl) {
  const cli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [cli, ...args, '--schema', schemaPath], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    throw new Error(`prisma ${args.filter(arg => !arg.startsWith('-')).join(' ')} failed:\n${output}`);
  }
}

function applyDatabase(url, { generateOnly = false } = {}) {
  const provider = detectProvider(url);
  const schema = renderSchema(provider);
  if (!existsSync(schemaPath) || readFileSync(schemaPath, 'utf8') !== schema) {
    writeFileSync(schemaPath, schema);
  }

  // The client is provider-specific, so regenerate whenever the rendered schema changes.
  const hash = createHash('sha256').update(schema).digest('hex');
  const generated = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : '';
  if (generated !== hash) {
    console.log(`[db] generating Prisma client for ${provider}`);
    prisma(['generate'], url);
    writeFileSync(markerPath, hash);
  }

  if (!generateOnly) {
    console.log(`[db] syncing schema (${provider})`);
    prisma(['db', 'push', '--skip-generate'], url);
  }
  return provider;
}

/**
 * @returns {{ url: string, provider: string, source: 'env' | 'config' | 'default', dataDir: string }}
 */
export function prepareDatabase({ generateOnly = false } = {}) {
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  const resolved = resolveDatabase(dataDir);

  try {
    const provider = applyDatabase(resolved.url, { generateOnly });
    if (resolved.source === 'config') {
      const config = readRuntimeConfig(dataDir);
      if (config.databaseError) {
        delete config.databaseError;
        writeRuntimeConfig(dataDir, config);
      }
    }
    return { ...resolved, provider, dataDir };
  } catch (err) {
    // A database chosen in the dashboard must never brick the boot: record why
    // it failed and fall back to the bundled SQLite file so the UI stays reachable.
    if (resolved.source !== 'config') throw err;
    console.error(`[db] saved database is unusable, falling back to SQLite:\n${err.message}`);
    const config = readRuntimeConfig(dataDir);
    config.databaseError = String(err.message).slice(0, 2000);
    writeRuntimeConfig(dataDir, config);
    const url = defaultSqliteUrl(dataDir);
    const provider = applyDatabase(url, { generateOnly });
    return { url, source: 'default', provider, dataDir };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  loadEnvFile();
  try {
    const result = prepareDatabase({ generateOnly: process.argv.includes('--generate-only') });
    console.log(`[db] ready: ${result.provider} (${result.source})`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
