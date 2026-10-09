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
/** What the stand-in model reports reading on an identity document. */
let ageReading = '{}';
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
      const silence = Buffer.alloc(24_000 * 2 * 0.3);
      if (body.contents[0].parts[0].text.includes('WAVPLEASE')) {
        // What the newest speech models send: a WAV file with a metadata block after the sound.
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.write('WAVEfmt ', 8);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(24_000, 24);
        header.writeUInt32LE(48_000, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(silence.length, 40);
        const credentials = Buffer.alloc(6000, 0x7f);
        const tail = Buffer.alloc(8);
        tail.write('C2PA', 0);
        tail.writeUInt32LE(credentials.length, 4);
        const file = Buffer.concat([header, silence, tail, credentials]);
        file.writeUInt32LE(file.length - 8, 4);
        return send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: file.toString('base64') } }] } }] });
      }
      return send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: silence.toString('base64') } }] } }] });
    }
    const last = body.contents.at(-1);
    const text = last.parts.map((p: any) => p.text ?? '').join(' ');
    // 'CALL:download_audio|{"query":"x"}' makes the stand-in call that function, the way a model does when asked for a song.
    const wanted = [...text.matchAll(/CALL:(\w+)\|(\{.*?\})(?= CALL:| SAYING|$)/g)];
    if (wanted.length && body.tools) {
      return send(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: 'planning', thought: true },
                ...(text.includes('SAYING') ? [{ text: 'Downloading it for you now!' }] : []),
                ...wanted.map(match => ({ functionCall: { name: match[1], args: JSON.parse(match[2]) } }))
              ]
            },
            finishReason: 'STOP'
          }
        ]
      });
    }
    // The age check: the stand-in "reads" whatever the test says is on the document.
    if (body.systemInstruction?.parts[0].text.includes('age gate')) {
      return send(200, { candidates: [{ content: { parts: [{ text: ageReading }] }, finishReason: 'STOP' }] });
    }
    // A model that types out a note it saw in its own earlier replies instead of calling a function.
    if (text.includes('PARROT')) return send(200, { candidates: [{ content: { parts: [{ text: '[ran the command: yts lelena]' }] }, finishReason: 'STOP' }] });
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

// The newest speech models answer with a WAV file, not bare samples. Everything in it that is
// not sound (the header, the metadata after the audio) must stay out of the voice note.
const described = ai.describeSpeech(Buffer.from('RIFF....WAVEfmt '), 'audio/wav');
const bare = ai.describeSpeech(Buffer.alloc(64), 'audio/l16; rate=16000; channels=2');
check('speech: files and bare samples are told apart', !described.raw && described.mimeType === 'audio/wav' && bare.raw?.sampleRate === 16000 && bare.raw.channels === 2 && ai.describeSpeech(Buffer.alloc(64)).raw?.sampleRate === 24000 && !ai.describeSpeech(Buffer.from('RIFF....WAVE'), 'audio/L16;rate=24000').raw);
const fromWav = (await say('.tts WAVPLEASE hello', { wait: 3500 })).sent.find(item => item.content.audio || item.content.document)?.content;
if (fromWav?.ptt) {
  const tools = await src('features/media-tools.ts');
  const samples: Buffer = await tools.convert(fromWav.audio, [], ['-f', 's16le', '-ar', '24000', '-ac', '1'], 'raw');
  let peak = 0;
  for (let offset = 0; offset + 1 < samples.length; offset += 2) peak = Math.max(peak, Math.abs(samples.readInt16LE(offset)));
  const seconds = samples.length / 2 / 24_000;
  check('tts: a WAV answer becomes a voice note with only its sound, no noise from the file around it', peak < 200 && seconds > 0.25 && seconds < 0.4, { peak, seconds });
} else {
  check('tts: without ffmpeg a WAV answer is passed on as it is', fromWav?.mimetype === 'audio/wav' && fromWav.fileName === 'speech.wav', fromWav && { ...fromWav, audio: undefined, document: undefined });
}

const translated = await say('.translate sinhala Good morning');
check('translate: language by name, done by the AI', translated.text.includes('*Translation*') && translated.text.includes('*To:* Sinhala') && translated.text.includes('*Echo:* Good morning') && /into Sinhala/.test(translated.calls[0]?.body.systemInstruction.parts[0].text), translated.text);
const toEnglish = await say('.tr', { quotedMessage: { conversation: 'Bonjour tout le monde' } });
check('translate: a bare reply means "into English"', toEnglish.text.includes('*To:* English') && toEnglish.text.includes('Bonjour tout le monde'), toEnglish.text);
check('translate: stays out of the chat memory', (await prisma.aiMessage.count({ where: { chatJid: translated.from } })) === 0);

// ================= the assistant downloading for people =================
const assistantTools = await src('commands/assistant-tools.ts');
const line = (name: string, args: object) => assistantTools.commandFor({ name, args });
check('downloads: a song by name becomes a direct download, never a menu', line('download_audio', { query: 'lelena' }).line === 'yta std lelena' && line('download_audio', { query: '  Lelena   Nilan  ', format: 'mp3' }).line === 'yta mp3 Lelena Nilan' && line('download_audio', { query: 'x', format: 'voice' }).line === 'yta voice x' && line('download_audio', { query: 'x', format: 'file' }).line === 'yta doc x');
check('downloads: a video by name or YouTube link, at 480p unless a quality is named', line('download_video', { query: 'big buck bunny' }).line === 'ytv 480 big buck bunny' && line('download_video', { query: 'https://youtu.be/aqz-KE-bpKQ', quality: '720' }).line === 'ytv 720 https://youtu.be/aqz-KE-bpKQ' && line('download_video', { query: 'x', as_file: true }).line === 'ytv doc x' && line('download_video', { query: 'x', quality: '4k' }).line === 'ytv 480 x');
check('downloads: links go to the command of their site', line('download_video', { query: 'https://vm.tiktok.com/ZMabc/' }).line === 'tiktok https://vm.tiktok.com/ZMabc/ video' && line('download_audio', { query: 'https://www.facebook.com/watch?v=1' }).line === 'fb https://www.facebook.com/watch?v=1 audio' && line('download_video', { query: 'here https://www.instagram.com/reel/abc/ please', as_file: true }).line === 'insta https://www.instagram.com/reel/abc/ video doc' && line('download_audio', { query: 'https://music.youtube.com/watch?v=abc' }).line === 'yta std https://music.youtube.com/watch?v=abc');
check('downloads: unknown sites, local addresses and empty requests are refused in words', line('download_video', { query: 'https://example.org/v.mp4' }).problem.includes('cannot download from that site') && line('download_video', { query: 'http://192.168.1.1/x' }).problem && line('download_audio', { query: '  ' }).problem.includes('name of the song'));

const toolsBefore = { ...getSettings().ai };
await updateSettings({ ai: { enabled: true, scope: 'private', downloads: true } });
const functionsIn = (request: any): string[] => (request?.body.tools?.[0].functionDeclarations ?? []).map((item: any) => item.name);
const noor = newPerson();
const refused = await say('get me this CALL:download_video|{"query":"https://example.org/clip.mp4"} SAYING', { from: noor, wait: 1200 });
const toolRules: string = refused.calls[0]?.body.systemInstruction.parts[0].text ?? '';
check('downloads: the model is offered the two download functions and nothing else', functionsIn(refused.calls[0]).join() === 'download_audio,download_video' && !JSON.stringify(refused.calls[0].body.tools).includes('run_command'), functionsIn(refused.calls[0]));
check('downloads: the prompt says how to use them, and stays short', toolRules.includes('call download_audio at once') && toolRules.includes('nothing but such a link') && toolRules.includes('Never ask which format') && toolRules.includes('.weather') && !toolRules.includes('sticker') && toolRules.length < 2600, toolRules.length);
check('downloads: the function is carried out and the model\'s own words are not sent', refused.sent.length === 1 && refused.text.includes('I cannot download from that site') && !refused.text.includes('Downloading it for you'), refused.texts);
const doneMemory = await prisma.aiMessage.findMany({ where: { chatJid: noor }, orderBy: { createdAt: 'asc' } });
check('downloads: the chat memory marks the request as done in the person\'s turn, with no assistant turn to imitate', doneMemory.length === 1 && doneMemory[0].role === 'user' && doneMemory[0].text.endsWith('[system note: this was done and the result was sent to them]') && !doneMemory[0].text.includes('ran the command'), doneMemory.map((row: any) => [row.role, row.text]));
const afterDone = await say('thanks!', { from: noor });
check('downloads: the next message follows as one turn with that request', afterDone.calls[0]?.body.contents.length === 1 && afterDone.calls[0].body.contents[0].parts[0].text.endsWith('sent to them]') && afterDone.calls[0].body.contents[0].parts[1].text === 'thanks!', afterDone.calls[0]?.body.contents);

// Memory written by the previous version carries the note the model learned to type out.
const omar = newPerson();
await prisma.aiMessage.createMany({
  data: [
    { sessionId: 'default', chatJid: omar, role: 'user', text: 'download lelena', createdAt: new Date(Date.now() - 4000) },
    { sessionId: 'default', chatJid: omar, role: 'model', text: '[ran the command: yts lelena]', createdAt: new Date(Date.now() - 3000) },
    { sessionId: 'default', chatJid: omar, role: 'user', text: 'what is 2+2', createdAt: new Date(Date.now() - 2000) },
    { sessionId: 'default', chatJid: omar, role: 'model', text: 'It is 4.\n[ran the command: calc 2+2]', createdAt: new Date(Date.now() - 1000) }
  ]
});
const cleaned = await say('and now?', { from: omar });
const cleanedTurns = cleaned.calls[0]?.body.contents.map((turn: any) => [turn.role, turn.parts[0].text]);
check('memory: notes left by the old version are taken out of the assistant\'s turns', !JSON.stringify(cleanedTurns).includes('ran the command') && cleanedTurns.length === 3 && cleanedTurns[0][1].startsWith('download lelena\n[system note') && cleanedTurns[0][1].includes('what is 2+2') && cleanedTurns[1][1] === 'It is 4.', cleanedTurns);
const parrot = await say('PARROT download lelena');
check('downloads: a typed-out note is never sent as a reply', !parrot.sent.some(item => JSON.stringify(item.content).includes('ran the command')), parrot.texts);

const two = await say('CALL:download_audio|{"query":""} CALL:download_video|{"query":"https://example.org/a"} CALL:download_video|{"query":"https://example.org/b"}', { wait: 1500 });
check('downloads: at most two per message', two.sent.length === 2 && two.texts[0].includes('name of the song') && two.texts[1].includes('cannot download from that site'), two.texts);
const invented = await say('CALL:run_command|{"command":"mode","arguments":"private"}', { wait: 1000 });
check('downloads: a function that was not offered is not carried out', getSettings().commands.mode === 'public' && invented.sent.length === 0, invented.texts);
const viaCommand = await say('.ai CALL:download_video|{"query":"https://example.org/x"}', { owner: true, wait: 1500 });
check('downloads: the ai command can do the same', functionsIn(viaCommand.calls[0]).length === 2 && viaCommand.sent.length === 1 && viaCommand.text.includes('cannot download from that site'), viaCommand.texts);

await updateSettings({ commands: { disabled: ['tiktok'] } });
const offTikTok = await say('CALL:download_video|{"query":"https://vm.tiktok.com/ZMabc/"}', { wait: 1200 });
check('downloads: a switched-off download command stays off', offTikTok.sent.length === 1 && offTikTok.text.includes('not available here') && !offTikTok.calls[0].body.systemInstruction.parts[0].text.includes('TikTok'), offTikTok.texts);
await updateSettings({ commands: { disabled: [], mode: 'private' } });
const locked = await say('CALL:download_audio|{"query":"lelena"}');
check('downloads: in private mode a stranger is offered none', !locked.calls[0]?.body.tools && !locked.calls[0].body.systemInstruction.parts[0].text.includes('download_audio') && locked.text.includes('*Echo:*'), locked.text);
await updateSettings({ commands: { mode: 'public' }, downloads: { enabled: false } });
check('downloads: nor is anyone while downloads are switched off', !(await say('CALL:download_audio|{"query":"lelena"}')).calls[0]?.body.tools);
await updateSettings({ downloads: { enabled: true }, ai: { downloads: false } });
const plain = await say('CALL:download_audio|{"query":"lelena"}');
check('downloads: with the setting off the assistant only talks', !plain.calls[0]?.body.tools && plain.text.includes('*Echo:* CALL:download_audio') && plain.sent.length === 1, plain.text);
await updateSettings({ ai: { enabled: toolsBefore.enabled, scope: toolsBefore.scope, downloads: true } });

// ================= 18+ commands and the age gate =================
const adultFeature = await src('features/adult.ts');
const today = new Date('2026-10-09T00:00:00Z');
const judged = (reading: object | string) => adultFeature.judgeAgeProof(typeof reading === 'string' ? reading : JSON.stringify(reading), today);
check('age: full years, to the day', adultFeature.ageOn(new Date('2008-10-09T00:00:00Z'), today) === 18 && adultFeature.ageOn(new Date('2008-10-10T00:00:00Z'), today) === 17 && adultFeature.ageOn(new Date('1990-01-01T00:00:00Z'), today) === 36);
check(
  'age check: an adult by date of birth passes; the model\'s own opinion of the age is not asked for',
  judged({ document: true, dateOfBirth: '1998-05-20', birthYear: 1998, legible: true }).adult === true && judged('Here you go:\n```json\n{"document": true, "dateOfBirth": "2008-10-09", "legible": true}\n```').adult === true
);
check('age check: a minor does not', judged({ document: true, dateOfBirth: '2008-10-10', legible: true }).reason === 'under-age' && judged({ document: true, dateOfBirth: '2012-01-01', legible: true }).reason === 'under-age');
check('age check: with only a year, the latest birthday is assumed', judged({ document: true, dateOfBirth: null, birthYear: 2008, legible: true }).reason === 'under-age' && judged({ document: true, dateOfBirth: null, birthYear: 2007, legible: true }).adult === true);
check(
  'age check: not a document, unreadable, impossible or missing answers all fail',
  judged({ document: false, dateOfBirth: '1990-01-01', legible: true }).reason === 'not-a-document' && judged({ document: true, dateOfBirth: null, birthYear: null, legible: true }).reason === 'unreadable' && judged({ document: true, dateOfBirth: '1990-01-01', legible: false }).reason === 'unreadable' && judged({ document: true, dateOfBirth: '1850-01-01', legible: true }).reason === 'unreadable' && judged('I cannot help with that.').reason === 'unreadable' && judged({ document: 'yes', dateOfBirth: '1990-01-01' }).reason === 'not-a-document'
);
check('adult links: only the adult sites, never a local address', Boolean(adultFeature.parseAdultUrl('https://www.pornhub.com/view_video.php?viewkey=abc123')) && !adultFeature.parseAdultUrl('https://www.youtube.com/watch?v=abc') && !adultFeature.parseAdultUrl('https://pornhub.com.evil.example/x') && !adultFeature.parseAdultUrl('http://127.0.0.1/pornhub.com'));

check('18+: off by default, and says so', (await say('.phsearch something')).text.includes('18+ features are switched off') && (await say('.verify')).text.includes('switched off'));
check('18+: not in the menu while off', !(await say('.menu')).text.includes('18+'));
await say('.adult on', { owner: true });
check('18+: the owner switches it on from WhatsApp', getSettings().adult.enabled === true);
const gated = await say('.phsearch something');
check('18+: an unconfirmed person is sent to the age check, and nothing is searched', gated.text.includes('*Adults only*') && gated.text.includes('.verify') && gated.sent.length === 1, gated.text);
const inGroup = await say('.phsearch something', { jid: GROUP });
check('18+: never in a group, not even for the owner', inGroup.text.includes('Private chats only') && (await say('.phdl https://www.pornhub.com/view_video.php?viewkey=abc', { owner: true, jid: GROUP })).text.includes('Private chats only'), inGroup.text);
check('18+: verifying in a group is refused, so no document is posted there', (await say('.verify', { jid: GROUP, image: true })).text.includes('Never post an identity document in a group'));
const howTo = await say('.verify');
check('18+: without a photo, the check explains itself and what happens to the photo', howTo.text.includes('*Age check*') && howTo.text.includes('not kept by this bot') && howTo.calls.length === 0, howTo.text);

ageReading = JSON.stringify({ document: true, dateOfBirth: '2010-03-01', birthYear: 2010, legible: true });
const minor = await say('.verify', { image: true, wait: 1200 });
check('18+: a minor is turned away', minor.text.includes('*Not verified*') && minor.text.includes('18 and over') && getSettings().adult.verified.length === 0 && minor.calls[0]?.body.contents[0].parts.some((part: any) => part.inlineData), minor.text);
check('18+: the document check is a one-off question: nothing about it is kept in the chat memory', (await prisma.aiMessage.count({ where: { chatJid: minor.from } })) === 0);
ageReading = JSON.stringify({ document: false, dateOfBirth: null, birthYear: null, legible: false });
check('18+: a picture that is not a document is turned away', (await say('.verify', { image: true, wait: 1200 })).text.includes('does not look like an identity card'));
check('18+: the check cannot be worn down by trying again and again', adultFeature.takeAttempt('somebody') && adultFeature.takeAttempt('somebody') && adultFeature.takeAttempt('somebody') && !adultFeature.takeAttempt('somebody') && adultFeature.takeAttempt('somebody else'));
ageReading = JSON.stringify({ document: true, dateOfBirth: '1995-03-01', birthYear: 1995, legible: true });
const zara = newPerson();
const adultOk = await say('.verify', { from: zara, image: true, wait: 1200 });
check('18+: an adult is confirmed and remembered by number only', adultOk.text.includes('*Verified*') && getSettings().adult.verified.join() === zara.split('@')[0] && !JSON.stringify(getSettings().adult).includes('1995'), [adultOk.text, getSettings().adult]);
check('18+: the section appears in the menu, in private chats only', (await say('.menu', { from: zara })).text.includes('🔞 18+') && !(await say('.menu', { jid: GROUP })).text.includes('18+'));
check('18+: a confirmed adult gets through the gate', (await say('.phdl https://example.org/video', { from: zara })).text.includes('Send a Pornhub link') && (await say('.phsearch', { from: zara })).text.includes('phsearch <words>'));
await updateSettings({ downloads: { enabled: false } });
check('18+: the download switch applies here too', (await say('.phdl https://www.pornhub.com/view_video.php?viewkey=abc', { owner: true })).text.includes('Downloads are switched off'));
await updateSettings({ downloads: { enabled: true } });
await say(`.adult revoke ${zara.split('@')[0]}`, { owner: true });
check('18+: the owner can remove someone', getSettings().adult.verified.length === 0 && !adultFeature.isVerifiedAdult(zara));
await say('.adult allow 94771234567', { owner: true });
check('18+: and approve by hand', getSettings().adult.verified.join() === '94771234567' && adultFeature.isVerifiedAdult('94771234567@s.whatsapp.net') && (await say('.adult list', { owner: true })).text.includes('+94771234567'));
check('18+: only owners manage it', (await say('.adult off', { from: zara })).text.includes('Owner command') && getSettings().adult.enabled === true);
const offeredAdult: string[] = await registry.commandsFor(fake, { key: { remoteJid: ME, id: 'X', fromMe: true }, message: { conversation: 'x' } });
check('18+: the AI assistant is never given these commands, not even for the owner', offeredAdult.includes('song') && !offeredAdult.some(name => ['phsearch', 'phdl', 'verify', 'adult'].includes(name)), offeredAdult.filter(name => name.startsWith('ph')));
await updateSettings({ adult: { enabled: false, verified: [] } });

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
check('yta / ytv: list their formats', (await say('.yta')).text.includes('yta [std|mp3|small|voice|doc] <name or link>') && (await say('.ytv')).text.includes('ytv [360|480|720|1080|doc] <name or link>') && (await say('.yta mp3')).text.includes('yta [std|mp3|small|voice|doc]'));
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

relayed.length = 0;
const devCard = await say('.developer');
const devLinks = (interactive()?.nativeFlowMessage.buttons ?? []).map(params);
check('buttons: the developer card gets contact, portfolio and GitHub buttons under its cover', devLinks.length === 3 && interactive().nativeFlowMessage.buttons.every((button: any) => button.name === 'cta_url') && devLinks[0].display_text === '📞 Contact' && devLinks[0].url === 'https://wa.me/94766866297' && devLinks[1].display_text === '🌐 Portfolio' && devLinks[1].url === 'https://buddhika.dev' && devLinks[2].display_text === '💻 GitHub' && interactive().header.hasMediaAttachment && interactive().body.text.includes('*Developer*'), devLinks);
check('buttons: the developer contact card still follows', devCard.sent.length === 1 && devCard.sent[0].content.contacts?.contacts[0].vcard.includes('waid=94766866297'), devCard.sent.map(item => Object.keys(item.content)));

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
  const news = await say('.worldnews technology', { wait: 8000 });
  check('worldnews: numbered headlines', news.text.includes('*News: technology*') && /\*8\.\* \*/.test(news.text), news.text.slice(0, 200));
  const story = await say('2', { from: news.from, quote: news.sent[0]?.id });
  check('worldnews: a number returns the link', /^📰 \*.+\*\nhttps:\/\/news\.google\.com\//.test(story.text), story.text.slice(0, 120));
  const local = await say('.news en', { wait: 9000 });
  check('news: the latest Sri Lankan stories from Esana, with a picture', local.text.includes('*Latest news*') && /\*10\.\* \*/.test(local.text) && Boolean(local.sent[0]?.content.image), local.text.slice(0, 300));
  const full = await say('1', { from: local.from, quote: local.sent[0]?.id, wait: 6000 });
  check('news: a number sends the whole story with its link', full.text.startsWith('📰 *') && full.text.includes('https://www.helakuru.lk/esana/p/'), full.text.slice(0, 200));
  const clock = await say('.time Tokyo', { wait: 5000 });
  check('time: world clock', clock.text.includes('*Tokyo, Japan*') && clock.text.includes('Asia/Tokyo'), clock.text);
}

server.close();
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
