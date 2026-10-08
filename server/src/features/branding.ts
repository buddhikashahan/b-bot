import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import { parseMediaUrl } from './downloader.js';

// The bot's cover image, used on the main menu and info cards.
// Drop your own `cover.jpg` (or .png / .webp) into the data folder to replace the bundled one.

const log = scoped('branding');
const OVERRIDES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'];

let cached: { file: string; mtimeMs: number; full: Buffer; thumb: Buffer } | undefined;

function coverFile(): string {
  const custom = OVERRIDES.map(name => path.join(config.paths.data, name)).find(file => existsSync(file));
  return custom ?? path.join(config.paths.assets, 'cover.jpg');
}

async function load(): Promise<{ full: Buffer; thumb: Buffer } | undefined> {
  const file = coverFile();
  try {
    const { mtimeMs } = await stat(file);
    if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached;
    const original = await readFile(file);
    // Re-encode once: WhatsApp wants JPEG, and a custom cover may be huge.
    const full = await sharp(original).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer();
    const thumb = await sharp(original).resize(300, 300, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
    cached = { file, mtimeMs, full, thumb };
    return cached;
  } catch (err) {
    log.warn({ err }, `could not read the cover image at ${file}`);
    return undefined;
  }
}

/** The cover as a JPEG, or undefined when covers are switched off or the file is unreadable. */
export async function coverImage(): Promise<Buffer | undefined> {
  if (!getSettings().branding.coverOnMenu) return undefined;
  return (await load())?.full;
}

/** Small square version, for link-style preview cards. */
export async function coverThumbnail(): Promise<Buffer | undefined> {
  return (await load())?.thumb;
}

/**
 * Fetch a remote thumbnail (e.g. a video poster) and normalise it to a modest JPEG.
 * Returns undefined rather than failing: a preview is a nicety, never a requirement.
 */
export async function remoteThumbnail(url: string | undefined, width = 720): Promise<Buffer | undefined> {
  // The address comes from a web page's metadata, so it gets the same checks as a link in a chat.
  if (!url || !/^https:\/\//i.test(url) || !parseMediaUrl(url)) return undefined;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) return undefined;
    return await sharp(bytes).resize(width, width, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    return undefined;
  }
}
