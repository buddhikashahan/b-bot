// Media conversion commands against the real ffmpeg. Needs no internet; skipped when the machine has no ffmpeg.
// Run with `npm test` (scripts/test.mjs gives every suite its own throwaway SQLite database).
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);
const { connectDatabase, prisma } = await src('db.ts');
const { loadSettings } = await src('settings.ts');
const registry = await src('commands/registry.ts');
const dl = await src('features/downloader.ts');
const tools = await src('features/media-tools.ts');
const sharp = createRequire(import.meta.url)('sharp');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};

if (!(await dl.ffmpeg())) {
  console.log('SKIPPED: ffmpeg is not available on this machine.');
  process.exit(0);
}

await connectDatabase();
await loadSettings();
await registry.loadCommands();

// A three second clip of colour bars with a tone, made by ffmpeg itself.
const clip: Buffer = await tools.convert(
  { file: 'sine=frequency=440:duration=3' },
  ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-f', 'lavfi'],
  ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
  'mp4'
);
check('test clip: ffmpeg can encode H.264 + AAC', clip.length > 5000 && clip.subarray(4, 8).toString() === 'ftyp', clip.length);

const ME = '94700000001@s.whatsapp.net';
const sent: any[] = [];
let media: Buffer = clip;
let n = 0;
const fake: any = {
  id: 'default',
  log: { error: (...a: unknown[]) => console.log('  [bot.error]', JSON.stringify(a).slice(0, 300)), debug() {}, info() {}, warn() {} },
  connected: true,
  me: { jid: ME, lid: '9000000001@lid', name: 'Owner' },
  sock: { ev: new EventEmitter(), ws: new EventEmitter() },
  requireSock() {
    return this.sock;
  },
  async send(_jid: string, content: any) {
    sent.push(content);
    return { key: { id: `SENT${++n}` }, message: {} };
  },
  download: async () => media,
  alertJid: () => ME,
  isSelf: async (jid: string) => jid === ME,
  isOwner: async (ids: string[]) => ids.includes(ME),
  isGroupAdmin: () => false,
  botIsAdmin: () => false,
  sentByBot: () => false
};

const VIDEO = { videoMessage: { mimetype: 'video/mp4' } };
const VOICE = { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } };
const MUSIC = { audioMessage: { mimetype: 'audio/mpeg' } };
let sender = 100;
/** Run a command as a reply to a media message whose bytes are `data`. */
const run = async (text: string, quotedMessage: object, data: Buffer) => {
  sent.length = 0;
  media = data;
  const from = `947333${String(++sender).padStart(5, '0')}@s.whatsapp.net`;
  await registry.handleCommand(fake, {
    key: { remoteJid: from, id: `M${sender}`, fromMe: false },
    message: { extendedTextMessage: { text, contextInfo: { stanzaId: 'MEDIA1', participant: from, quotedMessage } } },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Kasun'
  });
  const reply = sent.find(content => !content.react) ?? {};
  return { reply, text: (reply.text ?? '') as string, reactions: sent.filter(content => content.react).map(content => content.react.text).join('') };
};
const isOgg = (buffer: unknown) => Buffer.isBuffer(buffer) && buffer.subarray(0, 4).toString() === 'OggS';
const isMp3 = (buffer: unknown) => Buffer.isBuffer(buffer) && (buffer.subarray(0, 3).toString() === 'ID3' || buffer[0] === 0xff);
const isMp4 = (buffer: unknown) => Buffer.isBuffer(buffer) && buffer.subarray(4, 8).toString() === 'ftyp';

// --- stickers and conversions ---------------------------------------------------------------------
const sticker = await run('.sticker', VIDEO, clip);
const stickerInfo = Buffer.isBuffer(sticker.reply.sticker) ? await sharp(sticker.reply.sticker).metadata() : undefined;
check('sticker: a video becomes an animated 512px WebP', stickerInfo?.format === 'webp' && stickerInfo.width === 512 && (stickerInfo.pages ?? 1) > 1 && sticker.reply.sticker.length < 900 * 1024, stickerInfo && { format: stickerInfo.format, width: stickerInfo.width, pages: stickerInfo.pages });
check('sticker: progress reactions', sticker.reactions === '⏳✅', sticker.reactions);

const mp3 = await run('.tomp3', VIDEO, clip);
check('tomp3: the sound of a video as an MP3', isMp3(mp3.reply.audio) && mp3.reply.mimetype === 'audio/mpeg' && mp3.reply.audio.length > 10_000, Object.keys(mp3.reply));
const voice = await run('.tovn', VIDEO, clip);
check('tovn: a voice note in Ogg/Opus', isOgg(voice.reply.audio) && voice.reply.ptt === true && /opus/.test(voice.reply.mimetype));
const gif = await run('.togif', VIDEO, clip);
check('togif: a silent looping MP4', isMp4(gif.reply.video) && gif.reply.gifPlayback === true);
check('togif: refuses anything but a video', (await run('.togif', MUSIC, mp3.reply.audio)).text.includes('Send a video with .togif'));

// --- sound effects: every filter must be one ffmpeg accepts ---------------------------------------
for (const effect of ['bass', 'nightcore', 'slow', 'fast', 'deep', 'chipmunk', 'reverse']) {
  const result = await run(`.${effect}`, MUSIC, mp3.reply.audio);
  check(`${effect}: returns an MP3`, isMp3(result.reply.audio) && result.reply.audio.length > 5000 && result.reactions === '⏳✅', result.text || Object.keys(result.reply));
}
const slowed = await run('.slow', MUSIC, mp3.reply.audio);
const sped = await run('.fast', MUSIC, mp3.reply.audio);
check('slow is longer than fast', slowed.reply.audio?.length > sped.reply.audio?.length * 1.2, [slowed.reply.audio?.length, sped.reply.audio?.length]);
const deepVoice = await run('.deep', VOICE, voice.reply.audio);
check('effects keep a voice note a voice note', isOgg(deepVoice.reply.audio) && deepVoice.reply.ptt === true);
check('effects work on the sound of a video too', isMp3((await run('.bass', VIDEO, clip)).reply.audio));

// --- trim -----------------------------------------------------------------------------------------
const cut = await run('.trim 0:01 0:02', VIDEO, clip);
check('trim: a piece of a video', isMp4(cut.reply.video) && cut.reply.video.length < clip.length, [cut.reply.video?.length, clip.length]);
const cutAudio = await run('.trim 1 2', MUSIC, mp3.reply.audio);
check('trim: a piece of an audio', isMp3(cutAudio.reply.audio) && cutAudio.reply.audio.length < mp3.reply.audio.length * 0.6, [cutAudio.reply.audio?.length, mp3.reply.audio.length]);
check('trim: explains itself when the times make no sense', (await run('.trim 5 2', VIDEO, clip)).text.includes('trim <start> <end>') && (await run('.trim', VIDEO, clip)).text.includes('trim <start> <end>'));

// --- failures and the speech path -----------------------------------------------------------------
const broken = await run('.tomp3', VIDEO, Buffer.from('this is not a video at all'));
check('a damaged file gets a tidy reply', broken.text.startsWith('❌ *Could not convert that*') && broken.reactions.endsWith('❌'), broken.text);
const pcm = Buffer.alloc(24_000 * 2); // one second of silence, as the speech models return it
check('raw speech audio (16-bit PCM) converts to a voice note', isOgg(await tools.toVoiceNote(pcm, ['-f', 's16le', '-ar', '24000', '-ac', '1'])));

await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
