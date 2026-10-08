import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg, run } from './downloader.js';

// Small ffmpeg wrapper for the media commands: sticker, voice note, MP3, GIF...

/** A media problem worth showing to the person who asked. */
export class MediaError extends Error {}

const CONVERT_TIMEOUT_MS = 120_000;

/**
 * Convert media with ffmpeg.
 * @param input the media bytes, or a file already on disk
 * @param inputArgs options placed before `-i` (e.g. raw audio format)
 * @param outputArgs options placed after `-i` (codecs, filters...)
 * @param extension extension of the output file, which decides its container
 */
export async function convert(
  input: Buffer | { file: string },
  inputArgs: string[],
  outputArgs: string[],
  extension: string
): Promise<Buffer> {
  const bin = await ffmpeg();
  if (!bin) throw new MediaError('This needs ffmpeg, which is not installed on the server. Run "npm install" again or install ffmpeg.');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bbot-media-'));
  try {
    let source: string;
    if (Buffer.isBuffer(input)) {
      source = path.join(dir, 'input');
      await writeFile(source, input);
    } else {
      source = input.file;
    }
    const target = path.join(dir, `output.${extension}`);
    try {
      await run(bin, ['-y', '-hide_banner', '-loglevel', 'error', ...inputArgs, '-i', source, ...outputArgs, target], CONVERT_TIMEOUT_MS);
    } catch (error) {
      const failure = error as { killed?: boolean; stderr?: string };
      if (failure.killed) throw new MediaError('That took too long to convert. Try a shorter clip.');
      throw new MediaError('I could not convert that file. It may be damaged or in a format I do not understand.');
    }
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Opus in an Ogg container: what WhatsApp plays as a voice note. */
export function toVoiceNote(input: Buffer | { file: string }, inputArgs: string[] = []): Promise<Buffer> {
  return convert(input, inputArgs, ['-vn', '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', '-ar', '48000'], 'ogg');
}

export function toMp3(input: Buffer | { file: string }, bitrate = '192k'): Promise<Buffer> {
  return convert(input, [], ['-vn', '-c:a', 'libmp3lame', '-b:a', bitrate], 'mp3');
}

/**
 * Animated WebP sticker from a short video or GIF (first 8 seconds, 512x512, transparent padding).
 * @param lighter trade smoothness and detail for a smaller file
 */
export function toAnimatedSticker(input: Buffer, lighter = false): Promise<Buffer> {
  const filter = `fps=${lighter ? 8 : 12},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  return convert(
    input,
    ['-t', lighter ? '6' : '8'],
    ['-an', '-vf', filter, '-c:v', 'libwebp', '-loop', '0', '-preset', 'default', '-q:v', lighter ? '20' : '45', '-compression_level', '6'],
    'webp'
  );
}

/** Silent looping MP4, which WhatsApp shows as a GIF. */
export function toGifVideo(input: Buffer): Promise<Buffer> {
  return convert(input, [], ['-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', '-t', '15'], 'mp4');
}
