import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { scoped } from '../logger.js';

// Media downloads are delegated to yt-dlp (https://github.com/yt-dlp/yt-dlp),
// which understands YouTube, Facebook, TikTok, Instagram, X and ~1800 other
// sites. B-Bot fetches the official standalone build on first use and keeps it
// in data/bin. ffmpeg (needed to join YouTube's separate picture and sound
// streams) comes from FFMPEG_PATH, the system, or the bundled ffmpeg-static package.

const log = scoped('downloader');

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const MAX_CONCURRENT = 2;
const LOOKUP_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 6 * 60_000;

export type MediaKind = 'audio' | 'video';

export interface MediaInfo {
  id: string;
  title: string;
  /** Page to open (and to download from). */
  url: string;
  durationSeconds?: number;
  uploader?: string;
  views?: number;
  site: string;
  /** Poster / cover image, when the site provides one. */
  thumbnail?: string;
}

export interface DownloadedMedia {
  info: MediaInfo;
  file: string;
  sizeBytes: number;
  extension: string;
  mimetype: string;
  /** False when WhatsApp cannot play this container inline; send it as a document instead. */
  playable: boolean;
  cleanup: () => Promise<void>;
}

/** How to deliver audio: the site's own AAC stream, an MP3, or a small low-bitrate file. */
export type AudioQuality = 'standard' | 'mp3' | 'small';

export interface DownloadOptions {
  audio?: AudioQuality;
  /** Largest video height to fetch (360, 480, 720, 1080). Lower is used when it would not fit the size limit. */
  maxHeight?: number;
}

export interface DownloadLimits {
  maxSizeMb: number;
  maxMinutes: number;
}

/** A failure worth showing to the person who asked, as opposed to a bug. */
export class DownloadError extends Error {}

// --- binaries --------------------------------------------------------------------------------

function releaseAsset(): string | undefined {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : process.arch === 'x64' ? 'yt-dlp_linux' : undefined;
  return undefined;
}

function localBinary(): string {
  return path.join(config.paths.bin, releaseAsset() ?? 'yt-dlp');
}

export function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // execFile (no shell): arguments are passed as-is, so nothing a user types can be interpreted as a command.
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function works(file: string, versionFlag = '--version'): Promise<string | undefined> {
  try {
    return (await run(file, [versionFlag], 15_000)).stdout.split('\n')[0].trim() || 'unknown';
  } catch {
    return undefined;
  }
}

/** Download the official yt-dlp build for this platform into data/bin, verified against the release checksums. */
export async function installYtDlp(): Promise<string> {
  const asset = releaseAsset();
  if (!asset) {
    throw new DownloadError(`No yt-dlp build is published for ${process.platform}/${process.arch}. Install yt-dlp yourself and set YTDLP_PATH.`);
  }
  log.info(`downloading ${asset} from the yt-dlp releases page`);
  const [binary, sums] = await Promise.all([
    fetch(`${RELEASES}/${asset}`, { signal: AbortSignal.timeout(180_000) }),
    fetch(`${RELEASES}/SHA2-256SUMS`, { signal: AbortSignal.timeout(30_000) })
  ]);
  if (!binary.ok || !sums.ok) throw new DownloadError(`Could not download yt-dlp (HTTP ${binary.ok ? sums.status : binary.status}).`);

  const bytes = Buffer.from(await binary.arrayBuffer());
  const expected = (await sums.text())
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!expected || expected.toLowerCase() !== actual) {
    throw new DownloadError('The downloaded yt-dlp file did not match its published checksum, so it was discarded.');
  }

  const target = localBinary();
  await mkdir(config.paths.bin, { recursive: true });
  await writeFile(`${target}.tmp`, bytes);
  await chmod(`${target}.tmp`, 0o755);
  await rename(`${target}.tmp`, target);
  resolved = Promise.resolve(target);
  log.info(`yt-dlp ${(await works(target)) ?? ''} installed`);
  return target;
}

let resolved: Promise<string> | undefined;

/** Path of a usable yt-dlp: YTDLP_PATH, then data/bin, then PATH, else install it. */
function ytDlp(): Promise<string> {
  resolved ??= (async () => {
    if (config.ytDlpPath) return config.ytDlpPath;
    if (existsSync(localBinary())) return localBinary();
    if (await works('yt-dlp')) return 'yt-dlp';
    return installYtDlp();
  })();
  // A failed attempt (e.g. no network) must not be cached forever.
  resolved.catch(() => (resolved = undefined));
  return resolved;
}

let ffmpegChecked: Promise<string | undefined> | undefined;

/** FFMPEG_PATH, then an ffmpeg on PATH, then the one shipped by the optional ffmpeg-static package. */
export function ffmpeg(): Promise<string | undefined> {
  ffmpegChecked ??= (async () => {
    for (const candidate of [config.ffmpegPath, 'ffmpeg']) {
      if (candidate && (await works(candidate, '-version'))) return candidate;
    }
    try {
      // Optional dependency: absent on platforms it has no build for.
      const bundled = ((await import('ffmpeg-static')) as { default: string | null }).default;
      if (bundled && (await works(bundled, '-version'))) return bundled;
    } catch {
      // not installed
    }
    return undefined;
  })();
  return ffmpegChecked;
}

export interface DownloaderStatus {
  /** Version string when yt-dlp is ready, null when it will be installed on first use. */
  ytDlpVersion: string | null;
  ffmpeg: boolean;
  cookies: boolean;
  supported: boolean;
}

/** State of the tooling, without installing anything. */
export async function downloaderStatus(): Promise<DownloaderStatus> {
  const candidates = [config.ytDlpPath, existsSync(localBinary()) ? localBinary() : undefined, 'yt-dlp'].filter(
    (item): item is string => Boolean(item)
  );
  let version: string | null = null;
  for (const candidate of candidates) {
    version = (await works(candidate)) ?? null;
    if (version) break;
  }
  return {
    ytDlpVersion: version,
    ffmpeg: Boolean(await ffmpeg()),
    cookies: existsSync(config.paths.cookies),
    supported: Boolean(releaseAsset()) || Boolean(version)
  };
}

// --- yt-dlp calls ----------------------------------------------------------------------------

/** Turn yt-dlp's stderr into one sentence a chat user can act on. */
function explain(error: unknown): DownloadError {
  const failure = error as { killed?: boolean; code?: string; stderr?: string; message?: string };
  if (error instanceof DownloadError) return error;
  if (failure.killed) return new DownloadError('That took too long, so I stopped. Try a shorter video.');
  if (failure.code === 'ENOENT') return new DownloadError('yt-dlp is not installed correctly. Reinstall it from the dashboard (Commands page).');
  const line =
    (failure.stderr ?? '')
      .split('\n')
      .map(text => text.trim())
      .filter(text => text.startsWith('ERROR:'))
      .pop() ?? '';
  const reason = line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/, '').trim();
  if (/sign in to confirm|not a bot/i.test(line)) {
    return new DownloadError('YouTube is refusing this server without a sign-in. Add a cookies.txt file to the data folder (see the README) and try again.');
  }
  if (/login required|log in|private|cookies/i.test(line)) {
    return new DownloadError('That post is private or needs a login, so I cannot fetch it.');
  }
  if (/unsupported url/i.test(line)) return new DownloadError('I do not know how to download from that link.');
  if (/requested format is not available/i.test(line)) {
    return new DownloadError('This site only offers that video as separate picture and sound, which needs ffmpeg to join. Install ffmpeg on the server and try again.');
  }
  if (/not available|unavailable|removed|no video/i.test(line)) return new DownloadError(reason || 'That media is not available.');
  log.warn(`yt-dlp failed: ${line || failure.message}`);
  return new DownloadError(reason ? reason.slice(0, 200) : 'The download failed. The site may have changed; try updating yt-dlp from the dashboard.');
}

interface RawEntry {
  id?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  original_url?: string;
  duration?: number;
  uploader?: string;
  channel?: string;
  view_count?: number;
  extractor_key?: string;
  ie_key?: string;
  thumbnail?: string;
  thumbnails?: { url?: string; width?: number }[];
  entries?: RawEntry[];
}

function toInfo(raw: RawEntry): MediaInfo {
  const site = raw.extractor_key ?? raw.ie_key ?? 'web';
  const url = raw.webpage_url ?? raw.original_url ?? (site.toLowerCase().startsWith('youtube') && raw.id ? `https://www.youtube.com/watch?v=${raw.id}` : raw.url) ?? '';
  const isYouTube = site.toLowerCase().startsWith('youtube');
  // Search results only list small thumbnails; YouTube's poster URL is predictable from the id.
  const largest = [...(raw.thumbnails ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
  return {
    id: raw.id ?? '',
    title: raw.title?.trim() || 'Untitled',
    url,
    durationSeconds: raw.duration ?? undefined,
    uploader: raw.channel ?? raw.uploader ?? undefined,
    views: raw.view_count ?? undefined,
    site,
    thumbnail: isYouTube && raw.id ? `https://i.ytimg.com/vi/${raw.id}/hqdefault.jpg` : (raw.thumbnail ?? largest)
  };
}

async function baseArgs(): Promise<string[]> {
  const args = ['--ignore-config', '--no-warnings', '--no-progress', '--socket-timeout', '20'];
  if (existsSync(config.paths.cookies)) args.push('--cookies', config.paths.cookies);
  return args;
}

/** Search YouTube. */
/**
 * The videos listed on a page (a site's search results, a playlist), without downloading any.
 * @param pageUrl must already have passed parseMediaUrl
 */
export async function listVideos(pageUrl: string, limit = 8): Promise<MediaInfo[]> {
  const bin = await ytDlp();
  try {
    const { stdout } = await run(bin, [...(await baseArgs()), '--flat-playlist', '--playlist-end', String(limit), '--dump-single-json', pageUrl], LOOKUP_TIMEOUT_MS);
    const result = JSON.parse(stdout) as RawEntry;
    return (result.entries ?? [])
      .map(toInfo)
      .filter(entry => entry.url)
      .slice(0, limit);
  } catch (error) {
    throw explain(error);
  }
}

export async function searchYouTube(query: string, limit = 8): Promise<MediaInfo[]> {
  const bin = await ytDlp();
  try {
    const { stdout } = await run(
      bin,
      [...(await baseArgs()), '--flat-playlist', '--dump-single-json', `ytsearch${limit}:${query}`],
      LOOKUP_TIMEOUT_MS
    );
    const result = JSON.parse(stdout) as RawEntry;
    return (result.entries ?? []).filter(entry => entry.id).map(toInfo);
  } catch (error) {
    throw explain(error);
  }
}

/** Title, length, thumbnail... of the media behind a link, without downloading it. */
export async function lookupMedia(url: string): Promise<MediaInfo> {
  const bin = await ytDlp();
  try {
    const { stdout } = await run(bin, [...(await baseArgs()), '--no-playlist', '--playlist-items', '1', '--dump-single-json', url], LOOKUP_TIMEOUT_MS);
    const raw = JSON.parse(stdout) as RawEntry;
    return toInfo(raw.entries?.[0] ?? raw);
  } catch (error) {
    throw explain(error);
  }
}

let active = 0;

/**
 * Download one audio track or video.
 * @param url a page URL (validate it first: see `parseMediaUrl`)
 */
export async function downloadMedia(url: string, kind: MediaKind, limits: DownloadLimits, options: DownloadOptions = {}): Promise<DownloadedMedia> {
  if (active >= MAX_CONCURRENT) throw new DownloadError('I am already busy with other downloads. Try again in a minute.');
  active++;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bbot-dl-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const bin = await ytDlp();
    const ffmpegPath = await ffmpeg();
    const args = [
      ...(await baseArgs()),
      '--no-playlist',
      '--playlist-items',
      '1',
      '--no-mtime',
      '--retries',
      '2',
      // Many sites serve a video as hundreds of small pieces. One at a time, a long video takes
      // many minutes; several at once is several times quicker.
      '--concurrent-fragments',
      '8',
      '--max-filesize',
      `${limits.maxSizeMb}M`,
      '--match-filter',
      `!is_live & duration <=? ${limits.maxMinutes * 60}`,
      '-o',
      path.join(dir, 'media.%(ext)s'),
      '--dump-json',
      '--no-simulate'
    ];
    if (ffmpegPath && ffmpegPath !== 'ffmpeg') args.push('--ffmpeg-location', ffmpegPath);
    /** Which streams to fetch and how to package them. */
    let format: string[];
    /** The same from a single file holding picture and sound: plainer, but the stream sites refuse least. */
    let plain: string[] | undefined;
    if (kind === 'audio') {
      // AAC in an M4A file plays everywhere in WhatsApp. Sites that already serve AAC are copied
      // as-is; with ffmpeg anything else (or the sound of a video) is converted to it.
      const quality = ffmpegPath ? (options.audio ?? 'standard') : 'standard';
      const convert =
        quality === 'mp3'
          ? ['-x', '--audio-format', 'mp3', '--audio-quality', '192K']
          : quality === 'small'
            ? ['-x', '--audio-format', 'mp3', '--audio-quality', '64K']
            : ffmpegPath
              ? ['-x', '--audio-format', 'm4a']
              : [];
      const source = quality === 'small' ? 'wa[abr>=40]/ba/b' : ffmpegPath ? 'ba[ext=m4a]/ba/b' : 'ba[ext=m4a]/ba[acodec^=mp4a]/ba/b';
      format = ['-f', source, ...convert];
      if (ffmpegPath) plain = ['-f', 'b', ...convert];
    } else {
      // H.264 + AAC in MP4 is what WhatsApp plays inline. Merging separate streams needs ffmpeg;
      // without it, take the best file that already contains both.
      // The size filters make yt-dlp step down to a lower quality that fits the limit
      // (leaving ~10% for the sound track) instead of failing on a long 720p video.
      const budget = Math.floor(limits.maxSizeMb * 0.9);
      const fitting = `bv*[filesize<${budget}M]+ba/bv*[filesize_approx<${budget}M]+ba/b[filesize<${limits.maxSizeMb}M]/b[filesize_approx<${limits.maxSizeMb}M]`;
      const preference = ['-S', `vcodec:h264,res:${options.maxHeight ?? 720},fps:30,acodec:m4a`];
      format = [...preference, ...(ffmpegPath ? ['-f', `${fitting}/bv*+ba/b`, '--merge-output-format', 'mp4'] : ['-f', `b[filesize<${limits.maxSizeMb}M]/b`])];
      if (ffmpegPath) plain = [...preference, '-f', `b[filesize<${limits.maxSizeMb}M]/b`];
    }

    const fetch = async (how: string[]) => {
      // Leftovers of a failed attempt must not be mistaken for the result.
      for (const name of await readdir(dir)) await rm(path.join(dir, name), { force: true, recursive: true });
      // A bigger allowance needs more time: about three seconds per megabyte, and never less than the usual.
      return run(bin, [...args, ...how, url], Math.max(DOWNLOAD_TIMEOUT_MS, limits.maxSizeMb * 3000));
    };
    // Video sites now and then refuse one stream of a perfectly available video ("403 Forbidden").
    // It usually works on a second request, and failing that from the single-file version.
    const refused = (error: unknown) => /HTTP Error 403/i.test((error as { stderr?: string }).stderr ?? '');
    let stdout: string;
    try {
      ({ stdout } = await fetch(format));
    } catch (first) {
      if (!refused(first)) throw first;
      log.warn('a stream was refused (HTTP 403); trying again');
      try {
        ({ stdout } = await fetch(format));
      } catch (second) {
        if (!refused(second) || !plain) throw second;
        log.warn('refused again; fetching the single-file version instead');
        ({ stdout } = await fetch(plain));
      }
    }
    const jsonLine = stdout.split('\n').find(line => line.startsWith('{'));
    if (!jsonLine) {
      // A real failure exits non-zero and lands in the catch below. Succeeding with
      // no output means --match-filter skipped the item (yt-dlp is silent about it here).
      throw new DownloadError(`That is a live stream or longer than ${limits.maxMinutes} minutes, which is over my limit.`);
    }
    const info = toInfo(JSON.parse(jsonLine) as RawEntry);

    const files = (await readdir(dir)).filter(name => !/\.(part|ytdl|tmp)$/.test(name));
    const sized = await Promise.all(files.map(async name => ({ name, size: (await stat(path.join(dir, name))).size })));
    const best = sized.sort((a, b) => b.size - a.size)[0];
    if (!best || best.size === 0) throw new DownloadError(`That file is larger than my ${limits.maxSizeMb} MB limit.`);
    if (best.size > limits.maxSizeMb * 1024 * 1024) throw new DownloadError(`That file is larger than my ${limits.maxSizeMb} MB limit.`);

    const extension = path.extname(best.name).slice(1).toLowerCase();
    // --max-filesize is applied per stream: an oversized picture stream is skipped while
    // its small sound stream still downloads. Sound alone is not the video that was asked for.
    if (kind === 'video' && !['mp4', 'mkv', 'webm', 'mov', 'm4v', 'flv', '3gp'].includes(extension)) {
      throw new DownloadError(`That video is larger than my ${limits.maxSizeMb} MB limit.`);
    }
    const audioTypes: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg' };
    const mimetype = kind === 'audio' ? (audioTypes[extension] ?? 'application/octet-stream') : extension === 'mp4' ? 'video/mp4' : 'application/octet-stream';
    return {
      info,
      file: path.join(dir, best.name),
      sizeBytes: best.size,
      extension,
      mimetype,
      playable: mimetype !== 'application/octet-stream',
      cleanup
    };
  } catch (error) {
    await cleanup().catch(() => {});
    throw explain(error);
  } finally {
    active--;
  }
}

// --- link checking ---------------------------------------------------------------------------

export const SITES = {
  youtube: ['youtube.com', 'youtu.be', 'music.youtube.com'],
  soundcloud: ['soundcloud.com'],
  reddit: ['reddit.com', 'redd.it'],
  vimeo: ['vimeo.com'],
  dailymotion: ['dailymotion.com', 'dai.ly'],
  twitch: ['twitch.tv'],
  threads: ['threads.net', 'threads.com'],
  snapchat: ['snapchat.com'],
  bilibili: ['bilibili.com', 'b23.tv'],
  likee: ['likee.video', 'likee.com'],
  facebook: ['facebook.com', 'fb.watch', 'fb.com'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com', 'instagr.am'],
  twitter: ['twitter.com', 'x.com'],
  pinterest: ['pinterest.com', 'pin.it']
} as const;
export type Site = keyof typeof SITES;

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i;

/** First http(s) link in a piece of text. */
export function findUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s<>"']+/i)?.[0];
}

/**
 * Validate a link before handing it to yt-dlp.
 * @param sites restrict to these services; omit to allow any public site
 * @returns the normalised URL, or undefined when it is not acceptable
 */
export function parseMediaUrl(input: string, sites?: Site[]): string | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || input.length > 600) return undefined;
  const host = url.hostname.toLowerCase();
  // Never let a chat message make this server fetch from itself or the local network.
  if (PRIVATE_HOST.test(host) || !host.includes('.')) return undefined;
  if (sites) {
    const allowed = sites.flatMap(site => SITES[site] as readonly string[]);
    if (!allowed.some(domain => host === domain || host.endsWith(`.${domain}`))) return undefined;
  }
  return url.toString();
}
