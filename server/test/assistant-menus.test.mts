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
          { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.5-flash-tts', supportedGenerationMethods: ['generateContent'] },
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
    if (body.generationConfig?.responseModalities?.includes('AUDIO')) {
      const silence = Buffer.alloc(24_000 * 2 * 0.3).toString('base64');
      return send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: silence } }] } }] });
    }
    const last = body.contents.at(-1);
    const text = last.parts.map((p: any) => p.text ?? '').join(' ');
    if (text.includes('BLOCKME')) return send(200, { promptFeedback: { blockReason: 'SAFETY' } });
    if (last.parts.some((p: any) => p.inlineData?.mimeType.startsWith('audio/'))) {
      return send(200, { candidates: [{ content: { parts: [{ text: 'HEARD: what time do you open\n\nWe open at *nine* every day. 🙂' }] }, finishReason: 'STOP' }] });
    }
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
/** Messages sent through the raw relay (interactive menus). */
const relayed: { jid: string; message: any; options: any }[] = [];
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
    profilePictureUrl: async () => undefined,
    rejectCall: async () => {},
    user: { id: ME },
    relayMessage: async (jid: string, message: any, options: any) => void relayed.push({ jid, message, options })
  },
  requireSock() {
    return this.sock;
  },
  async relay(jid: string, message: any, options: any) {
    await this.sock.relayMessage(jid, message, options);
    return options.messageId;
  },
  uploadImage: async (image: Buffer) => ({ url: 'https://mmg.whatsapp.net/fake', mimetype: 'image/jpeg', fileLength: image.length }),
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
  /** Message content to deliver as it is (button taps and other non-text messages). */
  raw?: object;
}
/** Deliver a message through the real event pipeline and collect what the bot sent back. */
const say = async (text: string, o: Opts = {}) => {
  const from = o.from ?? newPerson();
  const jid = o.jid ?? from;
  const context = o.quote || o.mention || o.quotedMessage ? { contextInfo: { stanzaId: o.quote ?? (o.quotedMessage ? 'SOMEONES-MESSAGE' : undefined), participant: o.quote ? ME : o.quotedMessage ? '94700000009@s.whatsapp.net' : undefined, mentionedJid: o.mention, quotedMessage: o.quotedMessage ?? (o.quote ? { conversation: 'menu' } : undefined) } } : {};
  const message = o.raw ?? (o.image ? { imageMessage: { caption: text, mimetype: 'image/jpeg', ...context } } : { extendedTextMessage: { text, ...context } });
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
  await ai.verifyKey('wrong-key', 'gemini-3.5-flash');
} catch (error: any) {
  badKind = error.kind;
}
check('key check: a wrong key is rejected', badKind === 'bad-key');
calls.length = 0;
const usable = await ai.verifyKey(KEY);
check('key check: lists models and never asks the model to write', calls.length === 0 && usable.includes('gemini-3.5-flash'), { calls: calls.length, usable });
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
check('models: only chat models are listed', JSON.stringify(await ai.listModels(KEY)) === '["gemini-3.5-flash","gemini-3.1-flash-lite"]', await ai.listModels(KEY));

const alice = newPerson();
const first = await say('What time do you open?', { from: alice });
const req = first.calls[0];
check('auto reply: private message is answered', first.sent.length === 1 && first.sent[0].jid === alice, first.sent);
check('request: key in header, model in path, not in URL', req?.key === KEY && req.model === 'gemini-3.5-flash' && !req.url.includes(KEY));
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
await updateSettings({ ai: { model: 'gemini-3.5-flash' } });
const slow = await say('.ai SLOWPLEASE', { wait: 5200 });
check('slow answer: reported as slowness, not as a network fault', slow.text.includes('took too long to answer') && !slow.text.includes('Could not reach'), slow.text);
check('slow answer: recorded for the dashboard', (await ai.aiStatus()).lastError?.message.includes('took too long'));
await sleep(2500);

// backup model
await updateSettings({ ai: { model: 'busy-model', fallbackModel: 'gemini-3.1-flash-lite' } });
const rescued = await say('.ai are you there');
check('overloaded model (503): the backup model answers', rescued.text.includes('*Echo:* are you there') && rescued.calls.map(c => c.model).join() === 'busy-model,gemini-3.1-flash-lite', rescued.calls.map(c => c.model));
const afterRescue = await ai.aiStatus();
check('overloaded model: the dashboard is told which model is answering', afterRescue.lastModel === 'gemini-3.1-flash-lite' && afterRescue.notice?.includes('busy-model') && afterRescue.lastError === null, afterRescue);
check('overloaded model: skipped for a while, so the next reply is immediate', (await say('.ai and now')).calls.map(c => c.model).join() === 'gemini-3.1-flash-lite');
await updateSettings({ ai: { model: 'silent-model' } });
const waited = await say('.ai hello there', { wait: 3200 });
check('silent model: the backup answers after the timeout', waited.text.includes('*Echo:* hello there') && waited.calls.map(c => c.model).join() === 'silent-model,gemini-3.1-flash-lite', waited.calls.map(c => c.model));
await updateSettings({ ai: { model: 'busy-model', fallbackModel: '' } });
const stranded = await say('.ai anyone');
check('no backup configured: says Google is overloaded', stranded.text.includes("servers are overloaded for this model"), stranded.text);
await updateSettings({ ai: { model: 'gemini-3.5-flash', fallbackModel: 'gemini-3.1-flash-lite' } });
const cooling = await say('.ai still cooling?');
check('a model that just failed goes to the back of the queue', cooling.calls.map(c => c.model).join() === 'gemini-3.1-flash-lite' && cooling.text.includes('*Echo:*'), cooling.calls.map(c => c.model));
await updateSettings({ ai: { model: 'gemini-3.7-flash' } });
check('a healthy main model answers itself and the notice clears', (await say('.ai back?')).calls.map(c => c.model).join() === 'gemini-3.7-flash' && (await ai.aiStatus()).notice === null);
await updateSettings({ ai: { model: 'gemini-3.5-flash' } });

await updateSettings({ ai: { model: 'no-such-model' } });
check('wrong model: clear message', (await say('.ai hi')).text.includes('does not exist for this key'));
await updateSettings({ ai: { model: 'gemini-3.5-flash' } });

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
await updateSettings({ ai: { enabled: false, model: 'gemini-3.5-flash', fallbackModel: 'gemini-3.1-flash-lite' } });
check('away without AI: sent as before', (await say('anyone home?')).text === 'I am away right now');
check('away: still never sent in groups', (await say('anyone home?', { jid: GROUP })).sent.length === 0);
await updateSettings({ autoReply: { awayEnabled: false, enabled: true } });

// ================= reply-by-number menus =================
const bob = newPerson();
const main = await say('.menu', { from: bob, name: 'Bob' });
console.log('\n================ .menu ================\n' + main.text + '\n=======================================\n');
check('menu: numbered categories with a reply hint', main.text.includes('╭━━〔 🤖 *B-Bot* 〕━━⬣') && /\*1\.\* 📋 General _\(\d+\)_/.test(main.text) && main.text.includes('_Reply to this message with a number to open a category_'));
const stored = await prisma.menuPrompt.findUnique({ where: { sessionId_messageId: { sessionId: 'default', messageId: main.sent[0].id } } });
check('menu: the main menu is the caption of the cover image', Buffer.isBuffer(main.sent[0].content.image) && main.sent[0].content.caption === main.text);
check('menu: the numbers are stored in the database', stored && JSON.parse(stored.options)[1].action.text === 'menu ai', stored?.options.slice(0, 200));

const downloads = await say('3', { from: bob, quote: main.sent[0].id });
check('reply with a number opens that category', downloads.text.includes('╭━━〔 📥 *Downloads* 〕━━⬣') && /\*\d+\.\* `\.song`/.test(downloads.text), downloads.text.slice(0, 200));
const songNumber = Number(downloads.text.match(/\*(\d+)\.\* `\.song`/)?.[1]);
check('category choice explains a command that needs input', (await say(String(songNumber), { from: bob, quote: downloads.sent[0].id })).text.includes('╭━━〔 📌 *.song* 〕━━⬣'));

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
check('custom menu: sent on its trigger (case-insensitive) with {name}', welcome.text.includes('╭━━〔 📋 *Surf Shop* 〕━━⬣') && welcome.text.includes('┃ Hello Dave! How can we help?') && welcome.text.includes('*3.* Opening hours'));
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

// ================= commands are not conversation =================
await updateSettings({ ai: { enabled: true, scope: 'private' }, autoReply: { enabled: false, awayEnabled: true, awayMessage: 'I am away right now', awayCooldownMinutes: 60 } });
const typo = await say('.sogn lofi beats');
check('a mistyped command gets a hint: no AI answer, no away message', typo.sent.length === 1 && typo.text.includes('Did you mean `.song`') && typo.calls.length === 0, typo.texts);
const unknownCommand = await say('.zzzzqqq hello');
check('an unknown command is not conversation', unknownCommand.sent.length === 0 && unknownCommand.calls.length === 0, unknownCommand.texts);
check('closest command: swapped letters, missing letters, aliases', registry.closestCommand('sogn', false) === 'song' && registry.closestCommand('men', false) === 'menu' && registry.closestCommand('tikto', false) === 'tiktok' && registry.closestCommand('hello', false) === undefined && registry.closestCommand('ok', false) === undefined);
check('closest command: owner commands are only suggested to owners', registry.closestCommand('updatedll', false) === undefined && registry.closestCommand('updatedll', true) === 'updatedl');
// Two commands answering to one word means one of them silently never runs.
const words = new Map<string, string[]>();
for (const file of ['general', 'ai', 'download', 'info', 'discover', 'media', 'language', 'utility', 'admin', 'fun']) {
  const list = Object.values(await src(`commands/builtin/${file}.ts`)).find(value => Array.isArray(value)) as { name: string; aliases?: string[] }[];
  for (const command of list) for (const word of [command.name, ...(command.aliases ?? [])]) words.set(word.toLowerCase(), [...(words.get(word.toLowerCase()) ?? []), `${file}:${command.name}`]);
}
const clashes = [...words].filter(([, owners]) => owners.length > 1);
check('built-in commands: no name or alias is claimed twice', clashes.length === 0 && words.size > 250, clashes);
await updateSettings({ ai: { enabled: false }, autoReply: { awayEnabled: false, enabled: true } });

// ================= speaking and translating =================
const language = await src('commands/builtin/language.ts');
const speech = await src('features/speech.ts');
check('language: names and codes', language.findLanguage('Sinhala')?.code === 'si' && language.findLanguage('ta')?.name === 'Tamil' && language.findLanguage('hello') === undefined);
check('speech: language guessed from the script', speech.guessLanguage('ආයුබෝවන්') === 'si' && speech.guessLanguage('வணக்கம்') === 'ta' && speech.guessLanguage('hello') === 'en');
const speechText = 'This is a sentence that goes on for a while. '.repeat(12).trim();
const chunks = speech.chunkText(speechText) as string[];
check('speech: long text is split at sentence ends into pieces the basic voice accepts', chunks.length > 2 && chunks.every(chunk => chunk.length <= 181) && chunks.join(' ') === speechText, chunks.map(chunk => chunk.length));

const spoken = await say('.tts Good morning everyone', { wait: 3500 });
const voice = spoken.sent.find(item => item.content.audio || item.content.document)?.content;
const ttsCall = spoken.calls.find(call => call.model.includes('tts'));
check('tts: asks a speech model for audio and sends it', Boolean(voice) && ttsCall?.model === 'gemini-3.5-flash-tts' && ttsCall.body.generationConfig.responseModalities[0] === 'AUDIO' && ttsCall.body.contents[0].parts[0].text === 'Good morning everyone', { sent: spoken.sent.map(item => Object.keys(item.content)), models: spoken.calls.map(call => call.model) });
check('tts: goes out as a voice note when ffmpeg is there, a WAV file otherwise', voice?.ptt === true ? /ogg/.test(voice.mimetype) && voice.audio.subarray(0, 4).toString() === 'OggS' : voice?.fileName === 'speech.wav', voice && { ...voice, audio: undefined, document: undefined });
const voiced = await say('.tts puck Hello', { wait: 3500 });
check('tts: a voice can be chosen', voiced.calls.find(call => call.model.includes('tts'))?.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName === 'Puck' && voiced.calls[0].body.contents[0].parts[0].text === 'Hello');
check('tts: explains itself without text', (await say('.tts')).text.includes('tts [voice] <text>'));

const translated = await say('.translate sinhala Good morning');
check('translate: language by name, done by the AI', translated.text.includes('*Translation*') && translated.text.includes('*To:* Sinhala') && translated.text.includes('*Echo:* Good morning') && /into Sinhala/.test(translated.calls[0]?.body.systemInstruction.parts[0].text), translated.text);
const toEnglish = await say('.tr', { quotedMessage: { conversation: 'Bonjour tout le monde' } });
check('translate: a bare reply means "into English"', toEnglish.text.includes('*To:* English') && toEnglish.text.includes('Bonjour tout le monde'), toEnglish.text);
check('translate: stays out of the chat memory', (await prisma.aiMessage.count({ where: { chatJid: translated.from } })) === 0);

// ================= voice notes =================
const aiBefore = { ...getSettings().ai };
await updateSettings({ ai: { enabled: true, scope: 'private', voice: 'Puck' } });
const voiceNote = (extra: object = {}) => ({ audioMessage: { ptt: true, seconds: 6, mimetype: 'audio/ogg; codecs=opus', ...extra } });
const voiceName = (call: any) => call?.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
const lena = newPerson();
const talked = await say('', { from: lena, raw: voiceNote(), wait: 3500 });
const listenCall = talked.calls.find(call => !call.model.includes('tts'));
const audioIn = listenCall?.body.contents.at(-1).parts.find((part: any) => part.inlineData);
const rules = listenCall?.body.systemInstruction.parts[0].text ?? '';
check('voice: a voice note is handed to the model as audio', audioIn?.inlineData.mimeType === 'audio/ogg' && audioIn.inlineData.data === photo.toString('base64') && rules.includes('HEARD: ') && rules.includes('read aloud'), rules.slice(-300));
const speakCall = talked.calls.find(call => call.model.includes('tts'));
check('voice: the answer is spoken in the chosen voice, without the transcript, markup or emoji', speakCall?.body.contents[0].parts[0].text === 'We open at nine every day.' && voiceName(speakCall) === 'Puck', speakCall?.body.contents);
const spokenReply = talked.sent[0]?.content;
check('voice: it comes back as one voice note', talked.sent.length === 1 && Buffer.isBuffer(spokenReply.audio) && (spokenReply.ptt === true ? spokenReply.audio.subarray(0, 4).toString() === 'OggS' : spokenReply.mimetype === 'audio/wav') && presence.includes('recording'), spokenReply && { ...spokenReply, audio: undefined });
const voiceMemory = await prisma.aiMessage.findMany({ where: { chatJid: lena }, orderBy: { createdAt: 'asc' } });
check('voice: the chat memory keeps what was said', voiceMemory.length === 2 && voiceMemory[0].text === '[voice message] what time do you open' && voiceMemory[1].text === 'We open at nine every day.', voiceMemory.map((row: any) => row.text));
const followUp = await say('and on Sunday?', { from: lena });
check('voice: a typed follow-up is answered in text, with the voice exchange as context', followUp.text.includes('turns=3') && !followUp.sent[0].content.audio, followUp.text);

await updateSettings({ ai: { voiceReplies: false } });
const written = await say('', { raw: voiceNote(), wait: 1200 });
check('voice: with spoken answers off the reply is text', written.text === 'We open at *nine* every day. 🙂' && !written.calls.some(call => call.model.includes('tts')) && !written.calls[0].body.systemInstruction.parts[0].text.includes('read aloud'), written.text);
await updateSettings({ ai: { voiceReplies: true } });
check('voice: a music file is not somebody talking', (await say('', { raw: voiceNote({ ptt: false }) })).sent.length === 0);
check('voice: very long recordings are left alone', (await say('', { raw: voiceNote({ seconds: 1200 }) })).sent.length === 0);
await updateSettings({ ai: { voiceNotes: false } });
check('voice: listening can be switched off', (await say('', { raw: voiceNote() })).sent.length === 0);
await updateSettings({ ai: { voiceNotes: true } });
check('voice: reply parsing copes with a model that skips the transcript', ai.splitHeard('Just an answer.').answer === 'Just an answer.' && ai.splitHeard('HEARD: hi\n\nHello!').heard === 'hi' && ai.splitHeard('heard:   hi there  \nHello!\nBye').answer === 'Hello!\nBye');
check('voice: text is cleaned up for the voice', ai.toSpeech('*Sure!* Here you go 👍 `ok`') === 'Sure! Here you go ok');

// ================= callers =================
const ring = async (id: string) => {
  sent.length = 0;
  calls.length = 0;
  ev.emit('call', [{ chatId: lena, from: lena, id, date: new Date(), status: 'offer', offline: false }]);
  await sleep(3000);
};
await updateSettings({ calls: { reject: true, message: 'No calls please', voiceGreeting: true, voiceMessage: 'Hello caller, please send a voice message.' } });
await ring('RING1');
check('calls: the caller is answered with a voice note instead of the text', sent.length === 1 && sent[0].jid === lena && Buffer.isBuffer(sent[0].content.audio) && calls[0]?.body.contents[0].parts[0].text === 'Hello caller, please send a voice message.' && voiceName(calls[0]) === 'Puck', sent.map(item => Object.keys(item.content)));
await ring('RING2');
check('calls: the spoken message is made once and reused', sent.length === 1 && Buffer.isBuffer(sent[0].content.audio) && calls.length === 0, calls.length);
await updateSettings({ calls: { voiceGreeting: false } });
await ring('RING3');
check('calls: without the voice note the text goes out', sent.length === 1 && sent[0].content.text === 'No calls please');
await updateSettings({ calls: { reject: false }, ai: { enabled: aiBefore.enabled, scope: aiBefore.scope, voice: 'Kore' } });

// ================= media commands =================
const mediaCommands = await src('commands/builtin/media.ts');
check('media: timestamps', mediaCommands.parseTimestamp('75') === 75 && mediaCommands.parseTimestamp('1:15') === 75 && mediaCommands.parseTimestamp('1:02:03') === 3723 && mediaCommands.parseTimestamp('soon') === undefined);
const kindOf = async (buffer: Buffer) => (await sharp(buffer).metadata()) as { format: string; width: number; height: number; hasAlpha: boolean };
const blurred = (await say('.blur', { image: true, wait: 1500 })).sent.find(item => item.content.image)?.content.image;
check('media: blur returns a photo', blurred && (await kindOf(blurred)).format === 'jpeg' && (await kindOf(blurred)).width === 2000);
const sticker = (await say('.sticker', { image: true, wait: 1500 })).sent.find(item => item.content.sticker)?.content.sticker;
check('media: sticker is a 512px WebP', sticker && (await kindOf(sticker)).format === 'webp' && (await kindOf(sticker)).width === 512);
const round = (await say('.circle', { image: true, wait: 1500 })).sent.find(item => item.content.sticker)?.content.sticker;
check('media: circle is a transparent round sticker', round && (await kindOf(round)).hasAlpha && (await sharp(round).ensureAlpha().raw().toBuffer())[3] === 0);
const turned = (await say('.rotate 90', { image: true, wait: 1500 })).sent.find(item => item.content.image)?.content.image;
check('media: rotate swaps width and height', turned && (await kindOf(turned)).width === 1200 && (await kindOf(turned)).height === 2000);
const meme = (await say('.meme when the tests pass | first time', { image: true, wait: 2000 })).sent.find(item => item.content.image)?.content.image;
const memeStats = meme && (await sharp(meme).stats());
check('media: meme draws its caption on the photo', meme && memeStats.channels[1].max > 200 && memeStats.channels[0].min < 60, memeStats?.channels.map((channel: any) => [channel.min, channel.max]));
check('media: meme asks for words', (await say('.meme', { image: true, wait: 1200 })).text.includes('meme top text | bottom text'));
check('media: commands explain what they need', (await say('.blur')).text.includes('Send a photo or a sticker with .blur') && (await say('.tomp3')).text.includes('a video or an audio'));

// ================= download commands (no network needed) =================
check('song / video: ask for a name or link', (await say('.song')).text.includes('song <name or link>') && (await say('.video')).text.includes('video <name or link>'));
check('yta / ytv: list their formats', (await say('.yta')).text.includes('yta [std|mp3|small|voice|doc] <link>') && (await say('.ytv')).text.includes('ytv [360|480|720|1080|doc] <link>'));
check('site commands accept only their own links', (await say('.fb https://www.youtube.com/watch?v=aqz-KE-bpKQ')).text.includes('Send a Facebook link') && (await say('.soundcloud')).text.includes('Send a SoundCloud link'));
check('downloads: links to private addresses are refused', (await say('.tiktok https://tiktok.com.localhost/video')).text.includes('Send a TikTok link') && (await say('.song http://192.168.1.1/a')).text.includes('not a YouTube link'));
await updateSettings({ downloads: { enabled: false } });
check('downloads: can be switched off', (await say('.song lofi')).text.includes('Downloads are switched off'));
await updateSettings({ downloads: { enabled: true } });

// ================= tappable menus (experimental) =================
await updateSettings({ menus: { buttons: true } });
const frank = newPerson();
const interactive = () => relayed.at(-1)?.message.viewOnceMessage.message.interactiveMessage;
const params = (button: any) => JSON.parse(button.buttonParamsJson);
relayed.length = 0;
const tapMenu = await say('.menu', { from: frank });
const flow = interactive();
const rows = flow ? params(flow.nativeFlowMessage.buttons[0]).sections[0].rows : [];
check('buttons: a long menu goes out as a pick-list, with the numbered text as its body', tapMenu.sent.length === 0 && flow?.body.text.includes('*1.* 📋 General') && flow.nativeFlowMessage.buttons[0].name === 'single_select' && rows.length >= 8 && rows[2].title.startsWith('📥 Downloads') && rows[2].id === `bbot:${relayed.at(-1).options.messageId}:3`, rows.slice(0, 3));
check('buttons: the cover image rides along as the header', flow?.header.hasMediaAttachment === true && flow.header.imageMessage.mimetype === 'image/jpeg' && flow.header.imageMessage.fileLength > 1000, flow?.header);
const shortcut = flow?.nativeFlowMessage.buttons[1];
check('buttons: "All commands" is a button beside the list', flow?.nativeFlowMessage.buttons.length === 2 && shortcut.name === 'quick_reply' && params(shortcut).display_text === '📜 All commands' && params(shortcut).id === `bbot:${relayed.at(-1).options.messageId}:${rows.length}`, shortcut);
check('buttons: marked as a native-flow message for the recipient', relayed.at(-1)?.options.additionalNodes[0].tag === 'biz' && relayed.at(-1).options.additionalNodes[0].content[0].attrs.type === 'native_flow');
const everything = await say('', { from: frank, raw: { templateButtonReplyMessage: { selectedId: shortcut && params(shortcut).id } } });
check('buttons: tapping "All commands" prints the full list', everything.text.includes('◦ `.weather` _<city>_'), everything.text.slice(0, 200));
relayed.length = 0;
await say('', { from: frank, raw: { interactiveResponseMessage: { nativeFlowResponseMessage: { name: 'single_select', paramsJson: JSON.stringify({ id: rows[2]?.id }) } } } });
check('buttons: picking a row opens that category', interactive()?.body.text.includes('*Downloads*') && !interactive().header, relayed.length);
const hana = newPerson();
await say('.menu', { from: hana });
relayed.length = 0;
await say('3', { from: hana });
check('buttons: typing the number still works', interactive()?.body.text.includes('*Downloads*'), relayed.length);
relayed.length = 0;
const few = await say('hi', { name: 'Gina' });
const quick = interactive()?.nativeFlowMessage.buttons ?? [];
check('buttons: three options or fewer become buttons', few.sent.length === 0 && quick.length === 3 && quick.every((button: any) => button.name === 'quick_reply') && params(quick[0]).display_text === 'Prices', quick);
check('buttons: short options are not repeated as numbered text', interactive()?.body.text.includes('Tap a button to choose') && !interactive().body.text.includes('*1.*'), interactive()?.body.text);

// A format choice like the one `.song` sends: every option a button, on top of the thumbnail.
const ivy = newPerson();
const formats = [
  { label: '🎵 *Audio* _standard quality_', button: '🎵 Audio', action: { type: 'command', text: 'ping' } },
  { label: '🎧 *MP3* _192 kbps_', button: '🎧 MP3 192 kbps', action: { type: 'text', text: 'mp3 it is' } },
  { label: '🪶 *Small file* _64 kbps, saves data_', button: '🪶 Small 64 kbps', action: { type: 'command', text: 'ping' } },
  { label: '🎙️ *Voice note*', button: '🎙️ Voice note', action: { type: 'command', text: 'ping' } },
  { label: '📄 *Audio as a file* _document_', button: '📄 Audio file', action: { type: 'command', text: 'ping' } }
];
relayed.length = 0;
await menus.sendMenu(fake, ivy, { header: '*Song*', options: formats, image: photo, style: 'buttons' });
const picker = interactive();
const pickerButtons = picker?.nativeFlowMessage.buttons ?? [];
const moreRows = pickerButtons[2] ? params(pickerButtons[2]).sections[0].rows : [];
check('buttons: a format choice is two buttons and "More options"', pickerButtons.length === 3 && pickerButtons.slice(0, 2).every((button: any) => button.name === 'quick_reply') && params(pickerButtons[0]).display_text === '🎵 Audio' && params(pickerButtons[1]).display_text === '🎧 MP3 192 kbps' && pickerButtons[2].name === 'single_select' && params(pickerButtons[2]).title === 'More options', pickerButtons.map((button: any) => button.name));
check('buttons: the other formats are in the list, described by the rest of their label', moreRows.length === 3 && moreRows[0].title === '🪶 Small 64 kbps' && moreRows[0].description === '🪶 Small file 64 kbps, saves data' && moreRows[0].id.endsWith(':3') && moreRows[2].title === '📄 Audio file', moreRows);
check('buttons: a format choice keeps its thumbnail and drops the numbered text', picker?.header.imageMessage.fileLength === photo.length && picker.body.text === '*Song*\n\n> _Tap a button to choose_', picker?.body.text);
const tapped = await say('', { from: ivy, raw: { templateButtonReplyMessage: { selectedId: params(pickerButtons[1]).id } } });
check('buttons: tapping a format runs it', tapped.text === 'mp3 it is', tapped.text);
check('buttons: the number of a button works too', (await say('2', { from: ivy })).text === 'mp3 it is');
const fromList = await say('', { from: ivy, raw: { interactiveResponseMessage: { nativeFlowResponseMessage: { name: 'single_select', paramsJson: JSON.stringify({ id: moreRows[0]?.id }) } } } });
check('buttons: picking from "More options" runs that format', fromList.text.includes('Pong'), fromList.text);
const long = formats.map(option => ({ label: option.label, action: option.action }));
relayed.length = 0;
await menus.sendMenu(fake, ivy, { header: '*Song*', options: long, style: 'buttons' });
check('buttons: labels too long for a button stay readable as numbered text', interactive()?.body.text.includes('*3.* 🪶 *Small file* _64 kbps, saves data_') && params(interactive().nativeFlowMessage.buttons[0]).display_text.endsWith('…'), interactive()?.body.text);
relayed.length = 0;
await menus.sendMenu(fake, ivy, { header: '*Many*', options: Array.from({ length: 12 }, (_, index) => ({ label: `Item ${index + 1}`, action: { type: 'text', text: 'x' } })), style: 'buttons' });
check('buttons: never more than three, however many options', interactive()?.nativeFlowMessage.buttons.length === 3 && params(interactive().nativeFlowMessage.buttons[2]).sections[0].rows.length === 10 && params(interactive().nativeFlowMessage.buttons[2]).sections[0].rows[0].title === 'Item 3');

const upload = fake.uploadImage;
fake.uploadImage = async () => {
  throw new Error('upload refused');
};
relayed.length = 0;
const noPicture = await say('.menu');
check('buttons: a picture that cannot be uploaded does not cost the menu', noPicture.sent.length === 0 && interactive() && !interactive().header && interactive().nativeFlowMessage.buttons[0].name === 'single_select');
fake.uploadImage = upload;

await updateSettings({ branding: { developerNumber: '94770000000', developerLink: 'https://github.com/buddhikashahan' } });
relayed.length = 0;
const devCard = await say('.developer');
const devLinks = (interactive()?.nativeFlowMessage.buttons ?? []).map(params);
check('buttons: the developer card gets contact, portfolio and GitHub buttons under its cover', devLinks.length === 3 && interactive().nativeFlowMessage.buttons.every((button: any) => button.name === 'cta_url') && devLinks[0].display_text === '📞 Contact' && devLinks[0].url === 'https://wa.me/94770000000' && devLinks[1].display_text === '🌐 Portfolio' && devLinks[1].url === 'https://buddhika.dev' && devLinks[2].display_text === '💻 GitHub' && interactive().header.hasMediaAttachment && interactive().body.text.includes('*Developer*'), devLinks);
check('buttons: the developer contact card still follows', devCard.sent.length === 1 && devCard.sent[0].content.contacts?.contacts[0].vcard.includes('waid=94770000000'), devCard.sent.map(item => Object.keys(item.content)));
await updateSettings({ branding: { developerNumber: '' } });

const relay = fake.sock.relayMessage;
fake.sock.relayMessage = async () => {
  throw new Error('not supported');
};
const fallback = await say('.menu');
check('buttons: a failed send falls back to the plain numbered menu', fallback.text.includes('*1.* 📋 General') && Buffer.isBuffer(fallback.sent[0]?.content.image));
const plainDev = await say('.developer');
check('buttons: a failed link card falls back to the plain card', plainDev.text.includes('*Developer*') && Buffer.isBuffer(plainDev.sent[0]?.content.image));
fake.sock.relayMessage = relay;
await updateSettings({ menus: { buttons: false } });
const numbered = await say('.menu');
check('menu: without buttons "All commands" is the last numbered option', /\*\d+\.\* 📜 All commands _on one page_\n\n> _Reply to this message with a number to open a category_$/.test(numbered.text) && Buffer.isBuffer(numbered.sent[0]?.content.image), numbered.text.slice(-160));

// ================= settings saved by an earlier version =================
const { setInternal } = await src('settings.ts');
await updateSettings({ ai: { model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.5-flash-lite' } });
await setInternal('settingsVersion', '1');
await loadSettings();
check('upgrade: the old default models move to the new pair', getSettings().ai.model === 'gemini-3.5-flash' && getSettings().ai.fallbackModel === 'gemini-3.1-flash-lite', getSettings().ai);
check('upgrade: the developer card gets its contact number', getSettings().branding.developerNumber === '94766866297', getSettings().branding);
await updateSettings({ branding: { developerNumber: '' } });
await loadSettings();
check('upgrade: a number removed afterwards stays removed', getSettings().branding.developerNumber === '');
await updateSettings({ ai: { model: 'gemini-3.7-pro', fallbackModel: 'my-own-backup' } });
await setInternal('settingsVersion', '1');
await loadSettings();
check('upgrade: models the owner picked are kept', getSettings().ai.model === 'gemini-3.7-pro' && getSettings().ai.fallbackModel === 'my-own-backup', getSettings().ai);
await updateSettings({ ai: { model: 'gemini-3.8-flash' } });
await loadSettings();
check('upgrade: runs once, so choosing an older model afterwards sticks', getSettings().ai.model === 'gemini-3.8-flash');
await updateSettings({ ai: { model: 'gemini-3.5-flash', fallbackModel: 'gemini-3.1-flash-lite' } });

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
