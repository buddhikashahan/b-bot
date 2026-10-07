import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const rootDir = path.resolve(serverDir, '..');

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const dataDir = path.resolve(rootDir, process.env.DATA_DIR || 'data');

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function waVersion(): [number, number, number] | undefined {
  const parts = (process.env.WA_VERSION ?? '').split(/[.,]/).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? (parts as [number, number, number]) : undefined;
}

export const config = {
  version: packageVersion(),
  env: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',
  host: process.env.HOST ?? '0.0.0.0',
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** No dashboard: pairing happens in the terminal (QR, or a code when PAIRING_PHONE is set). */
  headless: bool(process.env.HEADLESS),
  pairingPhone: (process.env.PAIRING_PHONE ?? '').replace(/\D/g, ''),
  authStore: process.env.AUTH_STORE === 'database' ? ('database' as const) : ('file' as const),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || undefined,
  appSecret: process.env.APP_SECRET || undefined,
  trustProxy: bool(process.env.TRUST_PROXY),
  waVersion: waVersion(),
  /** Optional explicit locations of the media tools; otherwise they are found or installed automatically. */
  ytDlpPath: process.env.YTDLP_PATH || undefined,
  ffmpegPath: process.env.FFMPEG_PATH || undefined,
  database: {
    url: process.env.DATABASE_URL ?? '',
    provider: process.env.BBOT_DB_PROVIDER ?? 'sqlite',
    source: (process.env.BBOT_DB_SOURCE ?? 'env') as 'env' | 'config' | 'default'
  },
  /** True when scripts/start.mjs will restart us after exit code 75. */
  supervised: process.env.BBOT_SUPERVISED === '1',
  paths: {
    root: rootDir,
    data: dataDir,
    sessions: path.join(dataDir, 'sessions'),
    mediaCache: path.join(dataDir, 'media-cache'),
    uploads: path.join(dataDir, 'uploads'),
    plugins: path.join(dataDir, 'plugins'),
    /** Tools B-Bot installs for itself (yt-dlp). */
    bin: path.join(dataDir, 'bin'),
    /** Optional Netscape-format cookies for sites that require a login to download. */
    cookies: path.join(dataDir, 'cookies.txt'),
    runtimeConfig: path.join(dataDir, 'bbot.config.json'),
    secret: path.join(dataDir, 'secret.key'),
    web: path.join(serverDir, 'public')
  }
};

export const RESTART_EXIT_CODE = 75;
export const DEFAULT_SESSION_ID = 'default';

for (const dir of [config.paths.sessions, config.paths.mediaCache, config.paths.uploads, config.paths.plugins]) {
  mkdirSync(dir, { recursive: true });
}
