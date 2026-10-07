// LIVE (needs internet): formatted menu, public look-up services, real media downloads.
// Run with `npm test` -- --live (scripts/test.mjs gives every suite its own throwaway SQLite database).
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';

const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);
const { connectDatabase, prisma } = await src('db.ts');
const { loadSettings, updateSettings } = await src('settings.ts');
const registry = await src('commands/registry.ts');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};

await connectDatabase();
await loadSettings();
await registry.loadCommands();

const ME = '94700000001@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const meta = { id: GROUP, subject: 'Test Group', desc: 'Be nice', creation: 1700000000, participants: [{ id: ME, admin: 'admin' }, { id: '94700000002@s.whatsapp.net', admin: null }] };

interface Sent {
  jid: string;
  content: any;
  /** For media sent from disk: did the file exist, and how big was it, at send time? */
  fileBytes?: number;
}
const sent: Sent[] = [];
let n = 0;
const fake: any = {
  id: 'default',
  log: { error: (...a: unknown[]) => console.log('  [bot.error]', JSON.stringify(a).slice(0, 300)), debug() {}, info() {}, warn() {} },
  connected: true,
  me: { jid: ME, lid: '9000000001@lid', name: 'Owner Name' },
  sock: { ev: new EventEmitter(), ws: new EventEmitter(), profilePictureUrl: async () => undefined },
  requireSock() {
    return this.sock;
  },
  async send(jid: string, content: any) {
    const media = content.audio ?? content.video ?? content.document;
    const file = media?.url;
    sent.push({ jid, content, fileBytes: file && existsSync(file) ? statSync(file).size : undefined });
    return { key: { id: `SENT${++n}` }, message: {} };
  },
  alertJid: () => ME,
  pnForLid: async () => undefined,
  isSelf: async (jid: string) => jid === ME,
  isOwner: async (ids: string[]) => ids.includes(ME),
  groupMeta: async () => meta,
  listGroups: () => [meta],
  invalidateGroup() {},
  isGroupAdmin: () => false,
  botIsAdmin: () => true,
  sentByBot: () => false
};

let sender = 100;
/** Run a command as a fresh stranger (so cooldowns never interfere), or as the owner. */
const run = async (text: string, options: { owner?: boolean; jid?: string } = {}) => {
  sent.length = 0;
  const from = `947111${String(++sender).padStart(5, '0')}@s.whatsapp.net`;
  const jid = options.jid ?? from;
  const msg = {
    key: { remoteJid: jid, id: `M${sender}`, fromMe: Boolean(options.owner), ...(jid.endsWith('@g.us') ? { participant: from } : {}) },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Kasun'
  };
  await registry.handleCommand(fake, msg);
  const texts = sent.map(item => item.content.text ?? item.content.caption).filter(Boolean) as string[];
  return { texts, text: texts.join('\n---\n'), sent: [...sent] };
};

// --- menu ---------------------------------------------------------------------------------------
const menu = await run('.menu all');
check('menu: boxed header with greeting and stats', menu.text.includes('╭─「 🤖 *B-Bot* 」') && menu.text.includes('Hello, *Kasun*') && menu.text.includes('*Prefix:* `.`'));
check('menu: every category is a card', ['📥 *Downloads*', '🔎 *Search & info*', '🧰 *Tools*', '🛡️ *Group admin*', '🎲 *Fun*'].every(title => menu.text.includes(`╭─「 ${title} 」`)));
check('menu: commands in inline code with italic arguments', menu.text.includes('◦ `.song` _<name or link>_') && menu.text.includes('◦ `.weather` _<city>_'));
check('menu: owner commands hidden from members', !menu.text.includes('👑') && !menu.text.includes('`.mode`') && !menu.text.includes('`.dl`'));
const ownerMenu = await run('.menu all', { owner: true });
check('menu: owner sees the Owner section', ownerMenu.text.includes('╭─「 👑 *Owner* 」') && ownerMenu.text.includes('`.mode`') && ownerMenu.text.includes('`.updatedl`'));
const category = await run('.menu downloads');
console.log('================ .menu downloads ================\n' + category.text + '\n=================================================\n');
check('menu <category>: lists descriptions', category.text.includes('╭─「 📥 *Downloads* 」') && category.text.includes('_Download a TikTok video from its link._'));
const detail = await run('.menu tt');
check('menu <alias>: command details card', detail.text.includes('╭─「 📌 *.tiktok* 」') && detail.text.includes('*Usage:* `.tiktok <link>`') && detail.text.includes('`.tt`'), detail.text);
check('menu <unknown>: friendly error', (await run('.menu nonsense')).text.startsWith('❌ *Unknown command*'));

// --- small new commands ---------------------------------------------------------------------------
check('botinfo: card', (await run('.botinfo')).text.includes('╭─「 🤖 *B-Bot is online* 」'));
check('botinfo: owner sees features', (await run('.alive', { owner: true })).text.includes('╭─「 ⚙️ *Features* 」'));
const pass = await run('.genpass 24');
check('genpass: monospace password of the requested length', /```[A-Za-z0-9!@#$%^&*\-_=+]{24}```/.test(pass.text), pass.text);
check('joke / fact / truth / dare reply with a quote block', (await Promise.all(['.joke', '.fact', '.truth', '.dare'].map(c => run(c)))).every(r => /\n> /.test(r.text)));
const fancy = await run('.fancy Hello 2026');
check('fancy: several styles', fancy.text.includes('𝐇𝐞𝐥𝐥𝐨 𝟐𝟎𝟐𝟔') && fancy.text.includes('ℍ𝕖𝕝𝕝𝕠'), fancy.text);
const owner = await run('.owner');
check('owner: sends a contact card for the linked number', owner.sent[0]?.content.contacts?.contacts[0].vcard.includes('waid=94700000001'), owner.sent[0]);
const report = await run('.report the sticker command is slow');
check('report: forwarded to the owner and acknowledged', report.sent.some(s => s.jid === ME && s.content.text.includes('the sticker command is slow')) && report.text.includes('Sent to the owner'));
check('group info card', (await run('.groupinfo', { jid: GROUP })).text.includes('╭─「 👥 *Test Group* 」'));
check('guard replies are formatted', (await run('.mode private')).text === '🔒 *Owner command*\n> This command is for the bot owner only.');
check('usage hints are formatted', (await run('.weather')).text.includes('> *Usage:* `.weather <city>`'));

// --- live lookups (need internet) -----------------------------------------------------------------
const wiki = await run('.wiki Sigiriya');
check('wiki', wiki.text.includes('╭─「 📚 *Sigiriya* 」') && wiki.text.includes('wikipedia.org'), wiki.text.slice(0, 300));
const define = await run('.define serendipity');
check('define', define.text.includes('╭─「 📖 *serendipity* 」') && define.text.includes('*noun*'), define.text.slice(0, 300));
const weather = await run('.weather Colombo');
check('weather', weather.text.includes('Colombo') && /\*Now:\* -?\d+°C/.test(weather.text) && weather.text.includes('*Humidity:*'), weather.text);
console.log(weather.text);
const fx = await run('.convert 100 usd lkr');
check('convert', /\*100 USD\* = \*[\d,.]+ LKR\*/.test(fx.text), fx.text);
const gh = await run('.github WhiskeySockets/Baileys');
check('github repo', gh.text.includes('*WhiskeySockets/Baileys*') && gh.text.includes('*Stars:*'), gh.text);
const tr = await run('.translate es Good morning my friend');
check('translate', tr.text.includes('*Translation (es)*') && /buen/i.test(tr.text), tr.text);
const short = await run('.shorten https://example.com/a/very/long/address?with=parameters');
check('shorten (either service)', /https:\/\/(is\.gd|tinyurl\.com)\/\w+/.test(short.text), short.text);
check('lookup failure is a tidy message', (await run('.define zzzzqqqxxnotaword')).text.startsWith('❌ *Could not look that up*'));

// --- downloads ---------------------------------------------------------------------------------
const search = await run('.yts big buck bunny blender');
console.log('\n================ .yts ================\n' + search.text.split('\n').slice(0, 12).join('\n') + '\n   ...\n======================================\n');
check('yts: formatted result list with links', search.text.includes('╭─「 🔎 *YouTube search* 」') && (search.text.match(/youtube\.com\/watch/g) ?? []).length >= 3);

const song = await run('.song big buck bunny blender');
const audio = song.sent.find(s => s.content.audio);
check('song by name: info card then a playable audio file', song.text.includes('╭─「 🎵 *Song* 」') && audio?.content.mimetype === 'audio/mp4' && (audio.fileBytes ?? 0) > 50_000, song.sent.map(s => Object.keys(s.content)));
check('song: progress reactions', song.sent.filter(s => s.content.react).map(s => s.content.react.text).join('') === '⏳✅');
check('song: temp file deleted after sending', audio && !existsSync(audio.content.audio.url));

const video = await run('.video https://www.youtube.com/watch?v=aqz-KE-bpKQ');
const clip = video.sent.find(s => s.content.video);
check('video by link: sent as mp4 with a caption card', clip?.content.mimetype === 'video/mp4' && clip.content.caption.includes('╭─「 🎬 *Video* 」') && clip.content.caption.includes('*Size:*') && (clip.fileBytes ?? 0) > 500_000, video.sent.map(s => Object.keys(s.content)));
console.log(clip?.content.caption);

check('site command rejects other sites', (await run('.tiktok https://www.youtube.com/watch?v=aqz-KE-bpKQ')).text.startsWith('❌ *Send a TikTok link*'));
check('site command rejects local addresses', (await run('.fb http://localhost:3000/api/health')).text.startsWith('❌ *Send a Facebook link*'));
check('song refuses non-YouTube links', (await run('.song https://example.com/track.mp3')).text.startsWith('❌ *That is not a YouTube link*'));
check('dl is owner-only', (await run('.dl https://vimeo.com/1')).text.includes('Owner command'));
check('dl refuses internal addresses even for the owner', (await run('.dl http://192.168.1.1/video.mp4', { owner: true })).text.includes('*Usage:*'));

await updateSettings({ downloads: { maxMinutes: 1 } });
check('length limit is enforced with a clear reply', (await run('.video https://www.youtube.com/watch?v=aqz-KE-bpKQ')).text.includes('longer than 1 minutes'));
await updateSettings({ downloads: { maxMinutes: 30, ownerOnly: true } });
check('owners-only setting', (await run('.yts cats')).text.includes('limited to the bot owner'));
await updateSettings({ downloads: { ownerOnly: false, enabled: false } });
check('disabled setting', (await run('.song anything')).text.startsWith('❌ *Downloads are switched off*'));
await updateSettings({ downloads: { enabled: true } });

await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
