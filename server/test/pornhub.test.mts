// The direct reader behind the 18+ commands: reading result lists and player settings, and
// fetching a file over many connections. Runs against a local stand-in server; no internet needed.
// Run with `npm test`.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);
const ph = await src('features/pornhub.ts');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const failsWith = async (work: () => Promise<unknown>) => work().then(() => undefined, (error: unknown) => (error instanceof ph.PornhubError ? (error as Error).message : `other: ${error}`));

// --- reading pages -----------------------------------------------------------------------------------
check('clock: minutes and hours', ph.clockToSeconds('25:08') === 1508 && ph.clockToSeconds('1:02:05') === 3725 && ph.clockToSeconds(' 0:09 ') === 9 && ph.clockToSeconds('soon') === undefined && ph.clockToSeconds('') === undefined);

const item = (key: string, title: string, clock: string) =>
  `<li class="pcVideoListItem videoBox" data-video-vkey="${key}"><div class="phimage"><a class="linkVideoThumb" href="/view_video.php?viewkey=${key}" title="${title}"><img alt="x"></a><var class="duration">${clock}</var></div><span class="title"><a href="/view_video.php?viewkey=${key}" title="${title}">${title}</a></span></li>`;
const searchPage = `<html><body>
<ul id="recommended">${item('promoted0000001', 'A promoted video', '1:00')}</ul>
<ul id="videoSearchResult" class="videos search-video-thumbs">
${item('abc123def4567', 'First &amp; best result', '25:08')}
${item('bcd234efa5678', 'Second result', '1:02:05')}
<li class="sniperModeEngaged">an advert</li>
${item('bad key!', 'Broken entry', '3:00')}
${item('cde345fab6789', 'Third result', '')}
</ul></body></html>`;
const found = ph.parseSearch(searchPage, 8);
check(
  'search: the results list is read, with links and lengths',
  found.length === 3 && found[0].title === 'First & best result' && found[0].url === 'https://www.pornhub.com/view_video.php?viewkey=abc123def4567' && found[0].durationSeconds === 1508 && found[1].durationSeconds === 3725 && found[2].durationSeconds === undefined,
  found
);
check('search: videos outside the results, adverts and broken entries are left out', !found.some((entry: any) => /promoted|Broken/.test(entry.title)));
check('search: no more than asked for', ph.parseSearch(searchPage, 2).length === 2 && ph.parseSearch('<html></html>', 8).length === 0);

const settings = { video_title: ' A sample title ', video_duration: 1508, mediaDefinitions: [{ format: 'hls', quality: '480', videoUrl: 'https://cdn.example/480.m3u8' }, { format: 'mp4', quality: [], videoUrl: '/video/get_media?s=token&v=abc', remote: true }] };
const videoPage = (vars: object) => `<script>\n\tvar flashvars_50776925 = ${JSON.stringify(vars)};\n\tvar player_mp4_seek = "ms";\n</script>`;
const parsed = ph.parseVideoPage(videoPage(settings));
check('video page: title, length and the address of the file list', parsed.title === 'A sample title' && parsed.durationSeconds === 1508 && parsed.listUrl === '/video/get_media?s=token&v=abc', parsed);
check('video page: a video with streams only has no file list', ph.parseVideoPage(videoPage({ ...settings, mediaDefinitions: settings.mediaDefinitions.slice(0, 1) })).listUrl === undefined);
let thrown = '';
try {
  ph.parseVideoPage('<html>Please verify you are human</html>');
} catch (error) {
  thrown = error instanceof ph.PornhubError ? 'reader error' : 'other';
}
check('video page: a page without player settings is a reader error, so the caller can fall back', thrown === 'reader error');

// --- fetching a file -----------------------------------------------------------------------------------
const body = randomBytes(5 * 1024 * 1024 + 12_345);
const requests: { range: string | undefined; referer: string | undefined }[] = [];
/** Pieces (by starting byte) that fail this many times before working. */
const flaky = new Map<number, number>();
let peak = 0;
let open = 0;
const server = http.createServer((req, res) => {
  const range = req.headers.range;
  requests.push({ range, referer: req.headers.referer });
  // Like the real file server: nothing for a request that does not come from the site.
  if (req.url === '/file.mp4' && !req.headers.referer?.startsWith('https://www.pornhub.com')) return void res.writeHead(404).end('not found');
  if (req.url === '/whole.mp4') return void res.writeHead(200, { 'Content-Length': body.length }).end(body);
  const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
  if (!match) return void res.writeHead(200, { 'Content-Length': body.length }).end(body);
  const from = Number(match[1]);
  const to = Math.min(Number(match[2]), body.length - 1);
  const left = flaky.get(from) ?? 0;
  if (left > 0) {
    flaky.set(from, left - 1);
    return void res.writeHead(503).end('busy');
  }
  open++;
  peak = Math.max(peak, open);
  // A short pause, so that pieces really are in flight together.
  setTimeout(() => {
    open--;
    res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${body.length}`, 'Content-Length': to - from + 1 }).end(body.subarray(from, to + 1));
  }, 30);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const dir = await mkdtemp(path.join(os.tmpdir(), 'bbot-ph-test-'));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

check('size: asked without fetching the file', (await ph.remoteSize(`${base}/file.mp4`)) === body.length && requests.at(-1)?.range === 'bytes=0-0');
check('size: requests say they come from the site, which the file server insists on', requests.every(request => request.referer === 'https://www.pornhub.com/'));
check('size: a server that only sends whole files is not for this reader', (await failsWith(() => ph.remoteSize(`${base}/whole.mp4`)))?.includes('cannot be fetched in pieces'));

requests.length = 0;
const target = path.join(dir, 'a.mp4');
await ph.fetchInPieces(`${base}/file.mp4`, target, body.length, 3);
const pieces = requests.map(request => request.range);
check('pieces: the file arrives complete and identical', sha(await readFile(target)) === sha(body));
check('pieces: fetched as separate ranges, several at once, each one once', pieces.length === 3 && new Set(pieces).size === 3 && pieces.includes('bytes=0-2097151') && pieces.includes(`bytes=4194304-${body.length - 1}`) && peak === 3, { pieces, peak });

flaky.set(2 * 1024 * 1024, 2);
requests.length = 0;
const second = path.join(dir, 'b.mp4');
await ph.fetchInPieces(`${base}/file.mp4`, second, body.length, 2);
check('pieces: one that fails is tried again, and the file is still right', sha(await readFile(second)) === sha(body) && requests.filter(request => request.range === 'bytes=2097152-4194303').length === 3, requests.map(request => request.range));

flaky.set(0, 99);
const lost = await failsWith(() => ph.fetchInPieces(`${base}/file.mp4`, path.join(dir, 'c.mp4'), body.length, 2));
check('pieces: one that keeps failing ends the download with a reader error', lost?.includes('kept failing'), lost);
flaky.clear();
const short = await failsWith(() => ph.fetchInPieces(`${base}/file.mp4`, path.join(dir, 'd.mp4'), body.length + 4096, 2));
check('pieces: a file that turns out shorter than announced is not passed off as complete', short?.includes('kept failing'), short);

await new Promise(resolve => server.close(resolve));
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
