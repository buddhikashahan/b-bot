// AI assistant (against a local stand-in for the Gemini API) and reply-by-number menus.
// Run with `npm test` (scripts/test.mjs gives every suite its own throwaway SQLite database).
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);

// --- stand-in for generativelanguage.googleapis.com ---------------------------------------------
interface Captured {
  model: string;
  key: string | undefined;
  url: string;
  body: any;
}
const calls: Captured[] = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => (raw += chunk));
  req.on('end', () => {
    const key = req.headers['x-goog-api-key'] as string | undefined;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (key !== 'good-key-1234567890') return send(400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
    if (req.method === 'GET' && req.url?.startsWith('/models')) {
      return send(200, {
        models: [
          { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] }
        ]
      });
    }
    const model = decodeURIComponent(req.url?.match(/\/models\/([^:]+):generateContent/)?.[1] ?? '');
    const body = JSON.parse(raw || '{}');
    calls.push({ model, key, url: req.url ?? '', body });
    if (model === 'no-such-model') return send(404, { error: { message: 'models/no-such-model is not found' } });
    if (model === 'busy-model') return send(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } });
    if (model === 'old-model' && body.generationConfig?.thinkingConfig) return send(400, { error: { message: 'Thinking level is not supported for this model.' } });
    const last = body.contents.at(-1);
    const text = last.parts.map((p: any) => p.text ?? '').join(' ');
    if (text.includes('BLOCKME')) return send(200, { promptFeedback: { blockReason: 'SAFETY' } });
    const image = last.parts.some((p: any) => p.inlineData);
    const delay = text.includes('SLOWPLEASE') || model === 'silent-model' ? 4000 : 0;
    setTimeout(() => send(200, {
      candidates: [
        {
          content: { parts: [{ text: 'secret reasoning', thought: true }, { text: `## Answer\n**Echo:** ${text}\n* turns=${body.contents.length}\n* image=${image}` }] },
          finishReason: 'STOP'
        }
      ]
    }), delay);
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
process.env.GEMINI_TIMEOUT_MS = '2000';

const { connectDatabase, prisma } = await src('db.ts');
const { loadSettings, updateSettings, getSettings } = await src('settings.ts');
const { attachHandlers } = await src('whatsapp/handlers.ts');
const registry = await src('commands/registry.ts');
const ai = await src('features/ai.ts');
const menus = await src('features/menus.ts');
const sharp = createRequire(import.meta.url)('sharp');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

await connectDatabase();
await loadSettings();
await registry.loadCommands();

const ME = '94700000001@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const meta = { id: GROUP, subject: 'Family', desc: '', participants: [{ id: ME, admin: 'admin' }, { id: '94700000002@s.whatsapp.net', admin: null }] };
const photo = await sharp({ create: { width: 2000, height: 1200, channels: 3, background: { r: 200, g: 60, b: 60 } } }).png().toBuffer();

interface Sent {
  id: string;
  jid: string;
  content: any;
  quoted: boolean;
}
const sent: Sent[] = [];
const presence: string[] = [];
let n = 0;
const ev = new EventEmitter();
const fake: any = {
  id: 'default',
  log: { error: (...a: unknown[]) => console.log('  [bot.error]', JSON.stringify(a).slice(0, 400)), debug() {}, info() {}, warn() {} },
  connected: true,
  me: { jid: ME, lid: '9000000001@lid', name: 'Sam' },
  sock: {
    ev,
    ws: new EventEmitter(),
    sendPresenceUpdate: async (type: string) => void presence.push(type),
    readMessages: async () => {},
    profilePictureUrl: async () => undefined
  },
  requireSock() {
    return this.sock;
  },
  async send(jid: string, content: any, options?: any) {
    const id = `SENT${++n}`;
    sent.push({ id, jid, content, quoted: Boolean(options?.quoted) });
    return { key: { id }, message: {} };
  },
  download: async () => photo,
  alertJid: () => ME,
  pnForLid: async () => undefined,
  isSelf: async (jid: string) => jid === ME || jid === '9000000001@lid',
  isOwner: async (ids: string[]) => ids.includes(ME),
  groupMeta: async () => meta,
  listGroups: () => [meta],
  invalidateGroup() {},
  isGroupAdmin: () => false,
  botIsAdmin: () => true,
  sentByBot: () => false
};
attachHandlers(fake, fake.sock, () => true);

let person = 500;
const newPerson = () => `947222${String(++person).padStart(5, '0')}@s.whatsapp.net`;
interface Opts {
  from?: string;
  jid?: string;
  owner?: boolean;
  quote?: string; // id of the message being replied to
  quotedMessage?: object;
  mention?: string[];
  image?: boolean;
  name?: string;
  wait?: number;
}
/** Deliver a message through the real event pipeline and collect what the bot sent back. */
const say = async (text: string, o: Opts = {}) => {
  const from = o.from ?? newPerson();
  const jid = o.jid ?? from;
  const context = o.quote || o.mention || o.quotedMessage ? { contextInfo: { stanzaId: o.quote ?? (o.quotedMessage ? 'SOMEONES-MESSAGE' : undefined), participant: o.quote ? ME : o.quotedMessage ? '94700000009@s.whatsapp.net' : undefined, mentionedJid: o.mention, quotedMessage: o.quotedMessage ?? (o.quote ? { conversation: 'menu' } : undefined) } } : {};
  const message = o.image ? { imageMessage: { caption: text, mimetype: 'image/jpeg', ...context } } : { extendedTextMessage: { text, ...context } };
  sent.length = 0;
  calls.length = 0;
  ev.emit('messages.upsert', {
    messages: [{ key: { remoteJid: jid, id: `IN${++n}`, fromMe: Boolean(o.owner), ...(jid.endsWith('@g.us') ? { participant: from } : {}) }, message, messageTimestamp: Math.floor(Date.now() / 1000), pushName: o.name ?? 'Alice' }],
    type: 'notify'
  });
  await sleep(o.wait ?? 450);
  const texts = sent.map(item => item.content.text ?? item.content.caption).filter(Boolean) as string[];
  return { from, texts, text: texts.join('\n---\n'), sent: [...sent], calls: [...calls] };
};

// ================= AI assistant =================
const KEY = 'good-key-1234567890';
await updateSettings({ ai: { enabled: true } });
check('ai: silent without an API key, even when switched on', (await say('hello')).sent.length === 0);
check('ai command: explains that no key is set', (await say('.ai hello')).text.includes('not set up yet'));
check('assistant on: refuses without a key', (await say('.assistant on', { owner: true })).text.includes('No API key yet'));

let badKind = '';
try {
  await ai.verifyKey('wrong-key', 'gemini-3.8-flash');
} catch (error: any) {
  badKind = error.kind;
}
check('key check: a wrong key is rejected', badKind === 'bad-key');
calls.length = 0;
const usable = await ai.verifyKey(KEY);
check('key check: lists models and never asks the model to write', calls.length === 0 && usable.includes('gemini-3.8-flash'), { calls: calls.length, usable });
await ai.setApiKey(KEY);
const storedKey = async () => (await prisma.setting.findUnique({ where: { key: '_geminiApiKey' } }))?.value ?? '';
check('key at rest: encrypted in the database, never plain text', (await storedKey()).startsWith('enc:v1:') && !(await storedKey()).includes(KEY));
ai.forgetCachedApiKey();
check('key at rest: decrypts back to the same key', (await ai.getApiKey()) === KEY);
await prisma.setting.update({ where: { key: '_geminiApiKey' }, data: { value: KEY } });
ai.forgetCachedApiKey();
check('key at rest: a key saved by an older version still works and is encrypted on first use', (await ai.getApiKey()) === KEY && (await storedKey()).startsWith('enc:v1:'));
const sealedValue = await storedKey();
await prisma.setting.update({ where: { key: '_geminiApiKey' }, data: { value: sealedValue.slice(0, -6) + 'AAAAAA' } });
ai.forgetCachedApiKey();
check('key at rest: a tampered or foreign value is refused, not used', (await ai.getApiKey()) === null);
await ai.setApiKey(KEY);
const stat = await ai.aiStatus();
check('status: reports a key without revealing it', stat.configured && stat.keyHint === '…7890' && !JSON.stringify(stat).includes(KEY), stat);
check('models: only chat models are listed', JSON.stringify(await ai.listModels(KEY)) === '["gemini-3.8-flash","gemini-3.5-flash-lite"]', await ai.listModels(KEY));

const alice = newPerson();
const first = await say('What time do you open?', { from: alice });
const req = first.calls[0];
check('auto reply: private message is answered', first.sent.length === 1 && first.sent[0].jid === alice, first.sent);
check('request: key in header, model in path, not in URL', req?.key === KEY && req.model === 'gemini-3.8-flash' && !req.url.includes(KEY));
check('request: system instruction carries persona, WhatsApp rules and context', /friendly, helpful assistant/.test(req?.body.systemInstruction.parts[0].text) && /WhatsApp markup/.test(req.body.systemInstruction.parts[0].text) && /private chat with Alice/.test(req.body.systemInstruction.parts[0].text) && /owner is Sam/.test(req.body.systemInstruction.parts[0].text));
check('reply: reasoning parts dropped, Markdown converted to WhatsApp', first.text === '*Answer*\n*Echo:* What time do you open?\n- turns=1\n- image=false', first.text);
check('typing indicator shown while answering', presence.includes('composing') && presence.at(-1) === 'paused');
check('request: asks for low thinking and leaves room for the answer', req?.body.generationConfig.thinkingConfig.thinkingLevel === 'low' && req.body.generationConfig.maxOutputTokens === 4096, req?.body.generationConfig);
await updateSettings({ ai: { thinking: 'high' } });
check('answer speed setting is sent to the model', (await say('think hard')).calls[0]?.body.generationConfig.thinkingConfig.thinkingLevel === 'high');
await updateSettings({ ai: { thinking: 'low' } });

const second = await say('And on Sunday?', { from: alice });
check('memory: the earlier exchange is sent as context', second.calls[0]?.body.contents.length === 3 && second.calls[0].body.contents[1].role === 'model' && second.calls[0].body.contents[0].parts[0].text === 'What time do you open?', second.calls[0]?.body.contents);
check('memory: other chats do not share it', (await say('hi there')).calls[0]?.body.contents.length === 1);

await updateSettings({ ai: { historyMessages: 4 } });
for (const word of ['one', 'two', 'three']) await say(word, { from: alice });
const capped = await say('four', { from: alice });
check('memory: only the latest messages are kept (limit 4)', capped.calls[0]?.body.contents.length === 5 && (await prisma.aiMessage.count({ where: { chatJid: alice } })) === 4, capped.calls[0]?.body.contents.length);
await say('.resetai', { from: alice });
check('resetai: forgets the chat', (await prisma.aiMessage.count({ where: { chatJid: alice } })) === 0 && (await say('fresh start', { from: alice })).calls[0]?.body.contents.length === 1);

await updateSettings({ ai: { prompt: 'You are Captain Bot, the assistant of a surf shop. Always mention the tide.', historyMessages: 12 } });
const custom = await say('hello', { from: alice });
check('custom prompt: replaces the built-in persona, house rules stay', /Captain Bot/.test(custom.calls[0]?.body.systemInstruction.parts[0].text) && !/friendly, helpful assistant/.test(custom.calls[0].body.systemInstruction.parts[0].text) && /WhatsApp markup/.test(custom.calls[0].body.systemInstruction.parts[0].text));

const pic = await say('what colour is this?', { image: true });
const imagePart = pic.calls[0]?.body.contents.at(-1).parts.find((p: any) => p.inlineData);
const sentImage = imagePart ? await sharp(Buffer.from(imagePart.inlineData.data, 'base64')).metadata() : undefined;
check('images: photo is sent to the model as a downsized JPEG', imagePart?.inlineData.mimeType === 'image/jpeg' && sentImage?.format === 'jpeg' && sentImage.width === 1280 && pic.text.includes('image=true'), sentImage);
check('images: a photo without a caption is still answered', (await say('', { image: true })).text.includes('image=true'));
await updateSettings({ ai: { images: false } });
check('images off: a bare photo is ignored', (await say('', { image: true })).sent.length === 0);
await updateSettings({ ai: { images: true } });

check('commands are never sent to the AI', (await say('.ping')).calls.length === 0);
check('own messages are never answered', (await say('note to self', { owner: true })).sent.length === 0);
check('safety block: no reply in automatic mode', (await say('BLOCKME please')).sent.length === 0);
check('safety block: the ai command explains', (await say('.ai BLOCKME')).text.includes("safety filters"));
check('status: last error is recorded for the dashboard', (await ai.aiStatus()).lastError?.message.includes('safety filters'));

// groups
check('groups: ignored while scope is private chats', (await say('anyone?', { jid: GROUP })).sent.length === 0);
await updateSettings({ ai: { scope: 'all' } });
check('groups: ignored unless mentioned', (await say('anyone?', { jid: GROUP })).sent.length === 0);
const mentioned = await say('@94700000001 what is for dinner', { jid: GROUP, mention: [ME], name: 'Kasun' });
check('groups: answers when mentioned, quoting the question', mentioned.sent.length === 1 && mentioned.sent[0].quoted && /Kasun: what is for dinner/.test(mentioned.calls[0].body.contents.at(-1).parts[0].text) && /group chat "Family"/.test(mentioned.calls[0].body.systemInstruction.parts[0].text), mentioned.calls[0]?.body.contents.at(-1));
check('groups: answers a reply to its own message', (await say('and dessert?', { jid: GROUP, quote: mentioned.sent[0].id })).sent.length === 1);
await updateSettings({ ai: { groupTrigger: 'always' } });
check('groups: "always" answers everything', (await say('good morning all', { jid: GROUP })).sent.length === 1);
await updateSettings({ ai: { scope: 'private', groupTrigger: 'mention' } });

// loop guard
const chatty = newPerson();
let answered = 0;
for (let i = 0; i < 11; i++) answered += (await say(`message ${i}`, { from: chatty, wait: 120 })).sent.length;
check('loop guard: at most 8 automatic answers per chat per minute', answered === 8, answered);

// task commands
const longText = 'The committee met on Tuesday to discuss the budget. '.repeat(6);
const summary = await say('.summarize', { quotedMessage: { conversation: longText } });
check('summarize: one-off instruction, nothing remembered', /Summarise the message/.test(summary.calls[0]?.body.systemInstruction.parts[0].text) && summary.calls[0].body.contents.length === 1 && (await prisma.aiMessage.count({ where: { chatJid: summary.from } })) === 0);
const ocr = await say('.ocr', { quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } } });
check('ocr: quoted photo goes to the model with a transcription instruction', ocr.calls[0]?.body.contents[0].parts.some((p: any) => p.inlineData) && /Transcribe all text/.test(ocr.calls[0].body.systemInstruction.parts[0].text));
const asked = await say('.ai what does this mean?', { quotedMessage: { conversation: 'Carpe diem' } });
check('ai: a replied-to message becomes part of the question', /About this message: "Carpe diem"/.test(asked.calls[0]?.body.contents.at(-1).parts[0].text));

await updateSettings({ ai: { model: 'old-model' } });
const legacy = await say('.ai hello old model');
check('model without thinking control: retried without it and answered', legacy.text.includes('*Echo:* hello old model') && legacy.calls.length === 2 && !legacy.calls[1].body.generationConfig.thinkingConfig, legacy.calls.map(c => c.body.generationConfig));
check('model without thinking control: remembered for next time', (await say('.ai again')).calls.length === 1);
await updateSettings({ ai: { model: 'gemini-3.8-flash' } });
const slow = await say('.ai SLOWPLEASE', { wait: 5200 });
check('slow answer: reported as slowness, not as a network fault', slow.text.includes('took too long to answer') && !slow.text.includes('Could not reach'), slow.text);
check('slow answer: recorded for the dashboard', (await ai.aiStatus()).lastError?.message.includes('took too long'));
await sleep(2500);

// backup model
await updateSettings({ ai: { model: 'busy-model', fallbackModel: 'gemini-3.5-flash-lite' } });
const rescued = await say('.ai are you there');
check('overloaded model (503): the backup model answers', rescued.text.includes('*Echo:* are you there') && rescued.calls.map(c => c.model).join() === 'busy-model,gemini-3.5-flash-lite', rescued.calls.map(c => c.model));
const afterRescue = await ai.aiStatus();
check('overloaded model: the dashboard is told which model is answering', afterRescue.lastModel === 'gemini-3.5-flash-lite' && afterRescue.notice?.includes('busy-model') && afterRescue.lastError === null, afterRescue);
check('overloaded model: skipped for a while, so the next reply is immediate', (await say('.ai and now')).calls.map(c => c.model).join() === 'gemini-3.5-flash-lite');
await updateSettings({ ai: { model: 'silent-model' } });
const waited = await say('.ai hello there', { wait: 3200 });
check('silent model: the backup answers after the timeout', waited.text.includes('*Echo:* hello there') && waited.calls.map(c => c.model).join() === 'silent-model,gemini-3.5-flash-lite', waited.calls.map(c => c.model));
await updateSettings({ ai: { model: 'busy-model', fallbackModel: '' } });
const stranded = await say('.ai anyone');
check('no backup configured: says Google is overloaded', stranded.text.includes("servers are overloaded for this model"), stranded.text);
await updateSettings({ ai: { model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.5-flash-lite' } });
const cooling = await say('.ai still cooling?');
check('a model that just failed goes to the back of the queue', cooling.calls.map(c => c.model).join() === 'gemini-3.5-flash-lite' && cooling.text.includes('*Echo:*'), cooling.calls.map(c => c.model));
await updateSettings({ ai: { model: 'gemini-3.7-flash' } });
check('a healthy main model answers itself and the notice clears', (await say('.ai back?')).calls.map(c => c.model).join() === 'gemini-3.7-flash' && (await ai.aiStatus()).notice === null);
await updateSettings({ ai: { model: 'gemini-3.8-flash' } });

await updateSettings({ ai: { model: 'no-such-model' } });
check('wrong model: clear message', (await say('.ai hi')).text.includes('does not exist for this key'));
await updateSettings({ ai: { model: 'gemini-3.8-flash' } });

// priority: keyword rule and dashboard menu come before the AI
await updateSettings({ autoReply: { enabled: true, rules: [{ id: 'r1', enabled: true, trigger: 'price', match: 'contains', response: 'Our price list', scope: 'all' }] } });
const ruled = await say('what is the price?');
check('keyword rule wins over the AI', ruled.text === 'Our price list' && ruled.calls.length === 0);
await updateSettings({ ai: { enabled: false } });
check('assistant off: ordinary messages are left alone', (await say('hello again')).sent.length === 0);
check('assistant off: the ai command still works', (await say('.ai still there?')).text.includes('*Echo:* still there?'));

// away message and the assistant
await updateSettings({ ai: { enabled: true, scope: 'private' }, autoReply: { enabled: false, awayEnabled: true, awayMessage: 'I am away right now', awayCooldownMinutes: 60 } });
const both = await say('are you free?');
check('away + AI on: only the AI answers', both.sent.length === 1 && both.text.includes('*Echo:* are you free?'), both.texts);
await updateSettings({ ai: { model: 'busy-model', fallbackModel: '' } });
const aiDown = await say('hello?', { wait: 900 });
check('away + AI unavailable: the away message steps in', aiDown.sent.length === 1 && aiDown.text === 'I am away right now', aiDown.texts);
await updateSettings({ ai: { enabled: false, model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.5-flash-lite' } });
check('away without AI: sent as before', (await say('anyone home?')).text === 'I am away right now');
check('away: still never sent in groups', (await say('anyone home?', { jid: GROUP })).sent.length === 0);
await updateSettings({ autoReply: { awayEnabled: false, enabled: true } });

// ================= reply-by-number menus =================
const bob = newPerson();
const main = await say('.menu', { from: bob, name: 'Bob' });
console.log('\n================ .menu ================\n' + main.text + '\n=======================================\n');
check('menu: numbered categories with a reply hint', main.text.includes('╭─「 🤖 *B-Bot* 」') && /\*1\.\* 📋 General _\(\d+\)_/.test(main.text) && main.text.includes('_Reply to this message with a number to open a category_'));
const stored = await prisma.menuPrompt.findUnique({ where: { sessionId_messageId: { sessionId: 'default', messageId: main.sent[0].id } } });
check('menu: the numbers are stored in the database', stored && JSON.parse(stored.options)[1].action.text === 'menu ai', stored?.options.slice(0, 200));

const downloads = await say('3', { from: bob, quote: main.sent[0].id });
check('reply with a number opens that category', downloads.text.includes('╭─「 📥 *Downloads* 」') && /\*\d\.\* `\.song`/.test(downloads.text), downloads.text.slice(0, 200));
const songNumber = Number(downloads.text.match(/\*(\d+)\.\* `\.song`/)?.[1]);
check('category choice explains a command that needs input', (await say(String(songNumber), { from: bob, quote: downloads.sent[0].id })).text.includes('╭─「 📌 *.song* 」'));

const general = await say('1', { from: bob, quote: main.sent[0].id });
const pingNumber = general.text.match(/\*(\d+)\.\* `\.ping`/)?.[1] ?? '0';
check('category choice runs a command that needs nothing', (await say(pingNumber, { from: bob, quote: general.sent[0].id })).text.includes('Pong'));
check('the same menu can be answered again later', (await say('8', { from: bob, quote: main.sent[0].id })).text.includes('*Fun*'));
check('a number that is not on the menu gets a hint', (await say('42', { from: bob, quote: main.sent[0].id })).text.includes('Reply with a number from 1 to'));

const carol = newPerson();
await say('.menu', { from: carol });
check('private chat: a bare number answers the latest menu', (await say('3', { from: carol })).text.includes('*Downloads*'));
const erin = newPerson();
const groupMenu = await say('.menu', { jid: GROUP, from: erin });
check('group: a bare number is ignored', (await say('3', { jid: GROUP, from: erin })).sent.length === 0);
check('group: quoting the menu works', (await say('3', { jid: GROUP, from: erin, quote: groupMenu.sent[0].id })).text.includes('*Downloads*'));
check('plain numbers elsewhere are left alone', (await say('7')).sent.length === 0);
check('owner picks from their own phone by quoting', (await say('1', { jid: carol, owner: true, quote: main.sent[0].id })).text.includes('*General*'));
check('menu all: the full list still exists', (await say('.menu all')).text.includes('◦ `.weather` _<city>_'));

const pick = await say('.ytpick https://www.youtube.com/watch?v=aqz-KE-bpKQ');
const pickRow = await prisma.menuPrompt.findUnique({ where: { sessionId_messageId: { sessionId: 'default', messageId: pick.sent[0].id } } });
check('ytpick: audio / video choice is registered', pick.text.includes('*1.* 🎵 Audio') && JSON.parse(pickRow!.options)[1].action.text === 'video https://www.youtube.com/watch?v=aqz-KE-bpKQ');

// ================= menus designed in the dashboard =================
const sub = await menus.createCustomMenu('default', menus.CustomMenuSchema.parse({ name: 'Hours', trigger: 'hours', title: 'Opening hours', options: [{ label: 'Weekdays', type: 'text', value: '9am to 6pm' }] }));
await menus.createCustomMenu(
  'default',
  menus.CustomMenuSchema.parse({
    name: 'Welcome',
    trigger: 'Hi',
    title: 'Surf Shop',
    body: 'Hello {name}! How can we help?',
    options: [
      { label: 'Prices', type: 'text', value: 'Boards from $20 a day, {name}.' },
      { label: 'Is the bot awake?', type: 'command', value: '.ping' },
      { label: 'Opening hours', type: 'menu', value: sub.id }
    ]
  })
);
const dave = newPerson();
const welcome = await say('hi', { from: dave, name: 'Dave' });
console.log('================ custom menu ================\n' + welcome.text + '\n=============================================\n');
check('custom menu: sent on its trigger (case-insensitive) with {name}', welcome.text.includes('╭─「 📋 *Surf Shop* 」') && welcome.text.includes('│ Hello Dave! How can we help?') && welcome.text.includes('*3.* Opening hours'));
check('custom menu: text option', (await say('1', { from: dave, name: 'Dave' })).text === 'Boards from $20 a day, Dave.');
check('custom menu: command option', (await say('2', { from: dave, quote: welcome.sent[0].id })).text.includes('Pong'));
const hours = await say('3', { from: dave, quote: welcome.sent[0].id });
check('custom menu: sub-menu option', hours.text.includes('*Opening hours*') && hours.text.includes('*1.* Weekdays'));
check('custom menu: sub-menu choice', (await say('1', { from: dave, quote: hours.sent[0].id })).text === '9am to 6pm');
check('custom menu: private-only by default', (await say('hi', { jid: GROUP })).sent.length === 0);
check('custom menu: exact match does not fire on longer text', (await say('hi there friend')).sent.length === 0);
let invalid = '';
try {
  menus.CustomMenuSchema.parse({ name: 'x', trigger: 'x', title: 'x', options: [] });
} catch (error: any) {
  invalid = error.issues[0].message;
}
check('custom menu: needs at least one option', invalid === 'Add at least one option.');

if (process.env.BBOT_LIVE_TESTS) {
  // ================= new look-ups (live) =================
  await updateSettings({ autoReply: { enabled: false } });
  const movies = await say('.imdb inception', { wait: 9000 });
  check('imdb: search gives a numbered list', movies.text.includes('*Films & series*') && /\*1\.\* 🎬 \*Inception\* _\(2010\)_/.test(movies.text), movies.text.slice(0, 300));
  const movie = await say('1', { from: movies.from, quote: movies.sent.find(s => s.content.text)?.id, wait: 7000 });
  console.log(movie.text);
  check('imdb: choosing a number shows rating, cast and plot with a poster', movie.text.includes('*Inception (2010)*') && /\*IMDb:\* \d\.\d\/10/.test(movie.text) && movie.text.includes('*Cast:*') && movie.text.includes('imdb.com/title/tt1375666') && Boolean(movie.sent[0]?.content.image));
  const coin = await say('.crypto btc', { wait: 6000 });
  check('crypto: live price', coin.text.includes('*Bitcoin (BTC)*') && /\*Price:\* [\d,.]+ USD/.test(coin.text) && coin.text.includes('*24 hours:*'), coin.text);
  const news = await say('.news technology', { wait: 8000 });
  check('news: numbered headlines', news.text.includes('*News: technology*') && /\*8\.\* \*/.test(news.text), news.text.slice(0, 200));
  const story = await say('2', { from: news.from, quote: news.sent[0]?.id });
  check('news: a number returns the link', /^📰 \*.+\*\nhttps:\/\/news\.google\.com\//.test(story.text), story.text.slice(0, 120));
  const clock = await say('.time Tokyo', { wait: 5000 });
  check('time: world clock', clock.text.includes('*Tokyo, Japan*') && clock.text.includes('Asia/Tokyo'), clock.text);
}

server.close();
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
