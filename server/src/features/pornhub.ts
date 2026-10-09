import { open } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { scoped } from '../logger.js';

// A small, direct reader for Pornhub: search results, and the plain MP4 files behind a video.
//
// Everything here can also be done through yt-dlp, and the commands fall back to it whenever
// this fails. The point of doing it directly is speed: no helper program to start for a
// search or for finding a video's files, and a file fetched over many connections at once.
// The site hands out a file slowly on any one connection, so the number of connections is
// what decides how long a download takes.
//
// Nothing is ever sent "without downloading": WhatsApp only accepts files that are uploaded to
// it, so every video has to pass through this server. This makes that passage short.

const log = scoped('pornhub');

const SITE = 'https://www.pornhub.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9'
};
/** Says "an adult has already confirmed" to the site's own age screen, which would otherwise be served instead of the page. */
const COOKIES = 'platform=pc; accessAgeDisclaimerPH=1; accessAgeDisclaimerUK=1; age_verified=1';
const PAGE_TIMEOUT_MS = 20_000;
/** The file server answers "not found" to any request that does not say it comes from the site. */
const FILE_HEADERS = { ...HEADERS, Referer: `${SITE}/`, Origin: SITE };

/** This reader could not do it (the site changed, blocked us, or is down). Callers fall back to yt-dlp. */
export class PornhubError extends Error {}

export interface PornhubResult {
  title: string;
  /** The video's page. */
  url: string;
  durationSeconds?: number;
}

export interface PornhubVideo {
  title: string;
  url: string;
  durationSeconds?: number;
  /** Plain MP4 files, best quality first. `quality` is the picture height (480, 720...). */
  files: { quality: number; url: string }[];
}

/** "25:08" or "1:02:05" as seconds. */
export function clockToSeconds(clock: string): number | undefined {
  const parts = clock.trim().split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isInteger(part) || part < 0)) return undefined;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

async function page(url: string, cookies = COOKIES, referer?: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { ...HEADERS, Cookie: cookies, ...(referer ? { Referer: referer } : {}) }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  } catch (err) {
    throw new PornhubError(`could not reach the site: ${err instanceof Error ? err.message : err}`);
  }
  if (!response.ok) throw new PornhubError(`the site answered ${response.status}`);
  return response;
}

/** Read the results out of a search page. */
export function parseSearch(html: string, limit: number): PornhubResult[] {
  const $ = cheerio.load(html);
  const results: PornhubResult[] = [];
  $('#videoSearchResult li[data-video-vkey]').each((_, element) => {
    const item = $(element);
    const key = item.attr('data-video-vkey');
    const title = (item.find('a[title]').first().attr('title') ?? item.find('.title a').text()).trim();
    if (!key || !/^[\w-]{6,40}$/.test(key) || !title) return;
    results.push({ title, url: `${SITE}/view_video.php?viewkey=${key}`, durationSeconds: clockToSeconds(item.find('var.duration').first().text()) });
  });
  return results.slice(0, limit);
}

export async function searchPornhub(query: string, limit: number): Promise<PornhubResult[]> {
  const html = await (await page(`${SITE}/video/search?search=${encodeURIComponent(query)}`)).text();
  const results = parseSearch(html, limit);
  // A page with no list at all is the site showing us something else (a check, a block), not "nothing found".
  if (results.length === 0 && !html.includes('videoSearchResult')) throw new PornhubError('the search page had no result list');
  return results;
}

/** The player settings embedded in a video page. */
export function parseVideoPage(html: string): { title: string; durationSeconds?: number; listUrl?: string } {
  const json = /var flashvars_\d+\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(html)?.[1];
  if (!json) throw new PornhubError('the video page had no player settings');
  let vars: { video_title?: string; video_duration?: number | string; mediaDefinitions?: { format?: string; videoUrl?: string }[] };
  try {
    vars = JSON.parse(json);
  } catch {
    throw new PornhubError('the player settings could not be read');
  }
  // One entry does not hold a file but the address of the list of plain MP4 files.
  const listUrl = (vars.mediaDefinitions ?? []).find(media => media.format === 'mp4' && media.videoUrl)?.videoUrl;
  const seconds = Number(vars.video_duration);
  return { title: (vars.video_title ?? '').trim() || 'Untitled', durationSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : undefined, listUrl };
}

/** Find a video's title, length and plain MP4 files. */
export async function resolvePornhub(pageUrl: string): Promise<PornhubVideo> {
  const key = new URL(pageUrl).searchParams.get('viewkey');
  if (!key || !/^[\w-]{6,40}$/.test(key)) throw new PornhubError('not a video link this reader understands');
  const url = `${SITE}/view_video.php?viewkey=${key}`;
  const response = await page(url);
  // The list of files is only given to the session that opened the page.
  const session = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]);
  const { title, durationSeconds, listUrl } = parseVideoPage(await response.text());
  if (!listUrl) throw new PornhubError('this video offers no plain files');

  const list = (await (await page(new URL(listUrl, SITE).href, [COOKIES, ...session].join('; '), url)).json().catch(() => undefined)) as { quality?: string | number; format?: string; videoUrl?: string }[] | undefined;
  const files = (Array.isArray(list) ? list : [])
    .filter(entry => entry.format === 'mp4' && typeof entry.videoUrl === 'string' && /^https:\/\//.test(entry.videoUrl) && Number(entry.quality) > 0)
    .map(entry => ({ quality: Number(entry.quality), url: entry.videoUrl as string }))
    .sort((a, b) => b.quality - a.quality);
  if (files.length === 0) throw new PornhubError('the list of plain files was empty');
  return { title, url, durationSeconds, files };
}

// --- fetching a file over many connections -------------------------------------------------------

/** Connections used at once. The site limits each one, not their number. */
const CONNECTIONS = 24;
/** Each connection fetches pieces of this size, one after another. */
const PIECE_BYTES = 2 * 1024 * 1024;
const PIECE_TIMEOUT_MS = 45_000;
const PIECE_ATTEMPTS = 3;

/** How big a file is, asked without fetching it. */
export async function remoteSize(url: string): Promise<number> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { ...FILE_HEADERS, Range: 'bytes=0-0' }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  } catch (err) {
    throw new PornhubError(`could not reach the file: ${err instanceof Error ? err.message : err}`);
  }
  await response.body?.cancel().catch(() => {});
  const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]);
  // Without a total the server does not serve parts of the file, and this way of fetching is no use.
  if (response.status !== 206 || !Number.isFinite(total) || total <= 0) throw new PornhubError('the file cannot be fetched in pieces');
  return total;
}

/**
 * Fetch a file of known size into `target`, many pieces at a time.
 * @throws PornhubError when a piece keeps failing; the partial file is the caller's to remove
 */
export async function fetchInPieces(url: string, target: string, size: number, connections = CONNECTIONS): Promise<void> {
  const pieces = Array.from({ length: Math.ceil(size / PIECE_BYTES) }, (_, index) => index * PIECE_BYTES);
  const file = await open(target, 'w');
  const stop = new AbortController();
  try {
    const worker = async () => {
      for (let from = pieces.shift(); from !== undefined; from = pieces.shift()) {
        const to = Math.min(size, from + PIECE_BYTES) - 1;
        for (let attempt = 1; ; attempt++) {
          try {
            const response = await fetch(url, { headers: { ...FILE_HEADERS, Range: `bytes=${from}-${to}` }, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(PIECE_TIMEOUT_MS)]) });
            if (response.status !== 206) throw new Error(`HTTP ${response.status}`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length !== to - from + 1) throw new Error('a piece came back short');
            await file.write(bytes, 0, bytes.length, from);
            break;
          } catch (err) {
            if (stop.signal.aborted) return;
            if (attempt >= PIECE_ATTEMPTS) throw new PornhubError(`a piece of the file kept failing: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(connections, pieces.length) }, worker));
  } catch (err) {
    // One piece is lost for good: the others have nothing left to work for.
    stop.abort();
    log.warn(`a direct download was abandoned: ${err instanceof Error ? err.message : err}`);
    throw err;
  } finally {
    await file.close().catch(() => {});
  }
}
