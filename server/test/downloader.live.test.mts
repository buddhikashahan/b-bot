// LIVE (needs internet): installs yt-dlp, searches YouTube, downloads audio and video.
// Run with `npm test` -- --live (scripts/test.mjs gives every suite its own throwaway SQLite database).
import { existsSync } from 'node:fs';

const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);
const dl = await src('features/downloader.ts');
const fmt = await src('whatsapp/format.ts');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 500)}`}`);
};

// --- link checking (no network) ---------------------------------------------------------------
check('url: youtube accepted for youtube', dl.parseMediaUrl('https://youtu.be/abc123', ['youtube']));
check('url: subdomain accepted', dl.parseMediaUrl('https://vm.tiktok.com/ZM123/', ['tiktok']));
check('url: wrong site rejected', !dl.parseMediaUrl('https://www.tiktok.com/@u/video/1', ['youtube']));
check('url: lookalike domain rejected', !dl.parseMediaUrl('https://notyoutube.com/watch?v=1', ['youtube']) && !dl.parseMediaUrl('https://youtube.com.evil.io/x', ['youtube']));
check('url: localhost and private addresses rejected', ['http://localhost:3000/api', 'http://127.0.0.1/x', 'http://192.168.1.1/', 'http://10.0.0.5/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://intranet/'].every(u => !dl.parseMediaUrl(u)));
check('url: non-http schemes rejected', !dl.parseMediaUrl('file:///etc/passwd') && !dl.parseMediaUrl('ftp://example.com/a') && !dl.parseMediaUrl('--exec=calc'));
check('url: any public site allowed when unrestricted', dl.parseMediaUrl('https://vimeo.com/123'));
check('url: the newer sites are known', ['https://soundcloud.com/a/b', 'https://www.reddit.com/r/x/comments/1', 'https://vimeo.com/1', 'https://dai.ly/x1', 'https://clips.twitch.tv/a', 'https://www.threads.net/@a/post/b', 'https://b23.tv/a'].every((u, i) => dl.parseMediaUrl(u, [(['soundcloud', 'reddit', 'vimeo', 'dailymotion', 'twitch', 'threads', 'bilibili'] as const)[i]])));
check('findUrl', dl.findUrl('watch this https://fb.watch/abc?x=1 now') === 'https://fb.watch/abc?x=1');
check('format: clock/compact/size', fmt.clock(187) === '3:07' && fmt.clock(3725) === '1:02:05' && fmt.compact(1_250_000) === '1.3M' && fmt.fileSize(5 * 1024 * 1024) === '5.0 MB');

// --- install -----------------------------------------------------------------------------------
const before = await dl.downloaderStatus();
console.log('status before:', JSON.stringify(before));
const t0 = Date.now();
// Already installed by an earlier run of this test? Then just reuse it.
const bin = before.ytDlpVersion ? 'already-installed' : await dl.installYtDlp();
check('install: binary present (downloaded and checksum-verified on first run)', before.ytDlpVersion || existsSync(bin), bin);
const after = await dl.downloaderStatus();
check('install: version is reported afterwards', /^\d{4}\.\d{2}\.\d{2}/.test(after.ytDlpVersion ?? ''), after);
console.log(`      installed yt-dlp ${after.ytDlpVersion} in ${Math.round((Date.now() - t0) / 1000)}s, ffmpeg=${after.ffmpeg}`);

// --- search ------------------------------------------------------------------------------------
const results = await dl.searchYouTube('big buck bunny official trailer blender', 5);
check('search: returns results with title, link and duration', results.length >= 3 && results.every((r: any) => r.title && r.url.includes('youtube.com/watch')), results[0]);
console.log(results.map((r: any) => `      ${fmt.clock(r.durationSeconds)}  ${r.title.slice(0, 60)}  (${r.uploader})`).join('\n'));

check('search: every result has a thumbnail', results.every((r: any) => /^https:\/\/i\.ytimg\.com\/vi\/.+\/hqdefault\.jpg$/.test(r.thumbnail)), results[0]);

// Pick the shortest hit to keep the test quick.
const target = [...results].filter((r: any) => r.durationSeconds && r.durationSeconds < 240).sort((a: any, b: any) => a.durationSeconds - b.durationSeconds)[0] ?? results[0];
const limits = { maxSizeMb: 80, maxMinutes: 15 };
const longest = [...results].filter((r: any) => r.durationSeconds).sort((a: any, b: any) => b.durationSeconds - a.durationSeconds)[0];
console.log(`      short clip: ${fmt.clock(target.durationSeconds)}, long clip: ${fmt.clock(longest.durationSeconds)}`);

for (const kind of ['audio', 'video'] as const) {
  const started = Date.now();
  try {
    const media = await dl.downloadMedia(target.url, kind, limits);
    check(`download ${kind}: file exists with content`, existsSync(media.file) && media.sizeBytes > 20_000, media);
    check(`download ${kind}: playable type`, media.playable && (kind === 'audio' ? media.mimetype.startsWith('audio/') : media.mimetype === 'video/mp4'), media.mimetype);
    check(`download ${kind}: metadata`, media.info.title.length > 0 && media.info.durationSeconds > 0, media.info);
    console.log(`      ${kind}: ${fmt.fileSize(media.sizeBytes)} .${media.extension} (${media.mimetype}) in ${Math.round((Date.now() - started) / 1000)}s`);
    await media.cleanup();
    check(`download ${kind}: temp files removed`, !existsSync(media.file));
  } catch (error) {
    check(`download ${kind}`, false, (error as Error).message);
  }
}

// --- details, thumbnails and quality options -------------------------------------------------------
const branding = await src('features/branding.ts');
const looked = await dl.lookupMedia(target.url);
check('lookup: details of a link without downloading it', looked.title.length > 0 && looked.durationSeconds > 0 && looked.url.includes('youtube.com/watch') && /^https:\/\//.test(looked.thumbnail ?? ''), looked);
const poster = await branding.remoteThumbnail(looked.thumbnail);
check('thumbnail: fetched and normalised to a JPEG', Buffer.isBuffer(poster) && poster[0] === 0xff && poster[1] === 0xd8 && poster.length > 3000, poster?.length);
check('thumbnail: local and non-https addresses are never fetched', (await branding.remoteThumbnail('https://localhost/a.jpg')) === undefined && (await branding.remoteThumbnail('https://192.168.1.1/a.jpg')) === undefined && (await branding.remoteThumbnail('http://i.ytimg.com/a.jpg')) === undefined && (await branding.remoteThumbnail(undefined)) === undefined);

const sizes: Record<string, number> = {};
for (const audio of ['standard', 'mp3', 'small'] as const) {
  try {
    const media = await dl.downloadMedia(target.url, 'audio', limits, { audio });
    sizes[audio] = media.sizeBytes;
    check(`audio quality ${audio}: playable ${audio === 'standard' ? 'M4A' : 'MP3'}`, media.playable && media.extension === (audio === 'standard' ? 'm4a' : 'mp3') && media.sizeBytes > 10_000, media);
    console.log(`      ${audio}: ${fmt.fileSize(media.sizeBytes)} .${media.extension}`);
    await media.cleanup();
  } catch (error) {
    check(`audio quality ${audio}`, false, (error as Error).message);
  }
}
check('audio quality: "small" is well under the MP3 at 192 kbps', sizes.small < sizes.mp3 * 0.6, sizes);
for (const maxHeight of [360, 720]) {
  try {
    const media = await dl.downloadMedia(target.url, 'video', limits, { maxHeight });
    sizes[`v${maxHeight}`] = media.sizeBytes;
    check(`video up to ${maxHeight}p: an MP4`, media.playable && media.mimetype === 'video/mp4', media);
    console.log(`      ${maxHeight}p: ${fmt.fileSize(media.sizeBytes)}`);
    await media.cleanup();
  } catch (error) {
    check(`video up to ${maxHeight}p`, false, (error as Error).message);
  }
}
check('video quality: 360p is smaller than 720p', sizes.v360 < sizes.v720, sizes);

// --- limits and errors ---------------------------------------------------------------------------
try {
  const unexpected = await dl.downloadMedia(longest.url, 'video', { maxSizeMb: 80, maxMinutes: 1 });
  await unexpected.cleanup();
  check('limits: too-long video refused', false);
} catch (error) {
  check('limits: too-long video refused with a clear message', error instanceof dl.DownloadError && /longer than|live/.test((error as Error).message), (error as Error).message);
}
try {
  const unexpected = await dl.downloadMedia(longest.url, 'video', { maxSizeMb: 5, maxMinutes: 15 });
  await unexpected.cleanup();
  check('limits: oversize file refused', false, unexpected.sizeBytes);
} catch (error) {
  check('limits: oversize file refused with a clear message', error instanceof dl.DownloadError && /larger than my 5 MB limit/.test((error as Error).message), (error as Error).message);
}
try {
  await dl.downloadMedia('https://www.youtube.com/watch?v=xxxxxxxxxxx', 'audio', limits);
  check('errors: missing video reported', false);
} catch (error) {
  check('errors: missing video gives a readable message', error instanceof dl.DownloadError && (error as Error).message.length > 5, (error as Error).message);
  console.log(`      message: ${(error as Error).message}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
