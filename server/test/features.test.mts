// View-once recovery, edits, access control, auto-replies, call rejection, activity log, commands.
// Run with `npm test` (scripts/test.mjs gives every suite its own throwaway SQLite database).
import { EventEmitter } from 'node:events';
import path from 'node:path';

const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);

const { connectDatabase, prisma } = await src('db.ts');
const { loadSettings, updateSettings, getSettings } = await src('settings.ts');
const { attachHandlers } = await src('whatsapp/handlers.ts');
const registry = await src('commands/registry.ts');
const { calculate, parseDuration } = await src('commands/builtin/utility.ts');
const { matchesRule } = await src('features/auto-reply.ts');
const { recentActivity, activityStats } = await src('features/activity.ts');
const { sessions } = await src('whatsapp/session-manager.ts');
const { scheduler } = await src('scheduler/scheduler.ts');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 500)}`}`);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

await connectDatabase();
await loadSettings();

const ME = '94700000001@s.whatsapp.net';
const ME_LID = '9000000001@lid';
const GROUP = '120363000000000001@g.us';
const GROUP2 = '120363000000000002@g.us';
const ALICE = '94700000002@s.whatsapp.net';
const BOB = '94700000003@s.whatsapp.net';
const ADMIN = '94700000004@s.whatsapp.net';
const meta = {
  id: GROUP,
  subject: 'Test Group',
  desc: 'Be nice',
  participants: [
    { id: ME, admin: 'admin' },
    { id: ALICE, admin: null },
    { id: BOB, admin: null },
    { id: ADMIN, admin: 'admin' }
  ]
};

const sent: { jid: string; content: any }[] = [];
const sockCalls: any[] = [];
let n = 0;
const ev = new EventEmitter();
const ws = new EventEmitter();
const fake: any = {
  id: 'default',
  log: { error: (...a: unknown[]) => console.log('  [bot.error]', JSON.stringify(a).slice(0, 400)), debug() {}, info() {}, warn() {} },
  connected: true,
  me: { jid: ME, lid: ME_LID },
  sock: {
    ev,
    ws,
    sendMessage: async (jid: string, content: unknown) => void sockCalls.push(['sendMessage', jid, content]),
    groupParticipantsUpdate: async (...args: any[]) => {
      sockCalls.push(['groupParticipantsUpdate', ...args]);
      return (args[1] as string[]).map(jid => ({ jid, status: '200' }));
    },
    groupInviteCode: async () => 'OWNINVITECODE123',
    readMessages: async (keys: unknown) => void sockCalls.push(['readMessages', keys]),
    requestPlaceholderResend: async (key: unknown) => void sockCalls.push(['requestPlaceholderResend', key]),
    rejectCall: async (...args: unknown[]) => void sockCalls.push(['rejectCall', ...args]),
    profilePictureUrl: async () => undefined
  },
  requireSock() {
    return this.sock;
  },
  async send(jid: string, content: unknown) {
    sent.push({ jid, content });
    return { key: { id: `SENT${++n}` }, message: {} };
  },
  download: async () => Buffer.from('decrypted-media'),
  alertJid: () => ME,
  pnForLid: async () => undefined,
  isSelf: async (jid: string) => jid === ME || jid === ME_LID,
  isOwner: async (ids: string[]) => ids.includes(ME),
  groupMeta: async (jid: string) => ({ ...meta, id: jid }),
  listGroups: () => [meta],
  invalidateGroup() {},
  isGroupAdmin: (m: typeof meta, ids: string[]) => m.participants.some(p => p.admin && ids.includes(p.id)),
  botIsAdmin: () => true,
  sentByBot: () => false
};

const now = () => Math.floor(Date.now() / 1000);
const textMsg = (id: string, jid: string, text: string, from?: string, fromMe = false, extra: object = {}) => ({
  key: { remoteJid: jid, id, fromMe, ...(from ? { participant: from } : {}) },
  message: { extendedTextMessage: { text, ...extra } },
  messageTimestamp: now(),
  pushName: fromMe ? 'Me' : 'Alice'
});
attachHandlers(fake, fake.sock, () => true);
const upsert = async (message: unknown, wait = 350) => {
  ev.emit('messages.upsert', { messages: [message], type: 'notify' });
  await sleep(wait);
};
const reset = () => {
  sent.length = 0;
  sockCalls.length = 0;
};
await updateSettings({ commands: { enabled: false } });

// --- pure helpers ---------------------------------------------------------------------------
check('calculate: precedence and brackets', calculate('(12.5 + 7) * 3 - 2^3') === 50.5);
check('calculate: unary minus', calculate('-4 + 10 / 4') === -1.5);
let threw = false;
try {
  calculate('process.exit(1)');
} catch {
  threw = true;
}
check('calculate: refuses anything that is not arithmetic', threw);
check('parseDuration', parseDuration('1h30m') === 5_400_000 && parseDuration('10m') === 600_000 && parseDuration('soon') === undefined && parseDuration('10x') === undefined);
check('matchesRule: contains / exact / starts', matchesRule({ trigger: 'Price', match: 'contains' } as any, 'what is the PRICE?') && !matchesRule({ trigger: 'price', match: 'exact' } as any, 'price?') && matchesRule({ trigger: 'hi', match: 'starts' } as any, 'Hi there'));

// --- view-once: stub that WhatsApp withholds from linked devices -------------------------------
await updateSettings({ viewOnce: { enabled: true } });
reset();
// Raw stanza as the server sends it: no <enc>, only <unavailable type="view_once*">.
ws.emit('CB:message', {
  tag: 'message',
  attrs: { from: ALICE, id: 'VO1', t: String(now()), notify: 'Alice', type: 'media' },
  content: [{ tag: 'unavailable', attrs: { type: 'view_once_unavailable_fanout' }, content: undefined }]
});
await sleep(400);
const resend = sockCalls.find(call => call[0] === 'requestPlaceholderResend');
check('view-once: withheld stub is detected from the raw stanza', Boolean(resend), sockCalls);
check('view-once: asks the phone with a minimal key', resend && JSON.stringify(Object.keys(resend[1]).sort()) === '["fromMe","id","participant","remoteJid"]' && resend[1].id === 'VO1', resend?.[1]);

// The owner replies to it from their phone: the quote carries the media keys.
const quotedViewOnce = { imageMessage: { viewOnce: true, mimetype: 'image/jpeg', caption: 'for your eyes only', mediaKey: Buffer.alloc(32) } };
reset();
await upsert(textMsg('RPL1', ALICE, 'ok', undefined, true, { contextInfo: { stanzaId: 'VO1', participant: ALICE, quotedMessage: quotedViewOnce } }));
check('view-once: a reply reveals the media', sent.length === 1 && Buffer.isBuffer(sent[0]?.content.image), sent);
check('view-once: revealed copy goes to the alert chat with details', sent[0]?.jid === ME && sent[0]?.content.caption.includes('View-once image revealed') && sent[0]?.content.caption.includes('for your eyes only'), sent[0]);
check('view-once: revealed copy is not view-once', sent[0]?.content.viewOnce === undefined);
reset();
await upsert(textMsg('RPL2', ALICE, 'nice', undefined, true, { contextInfo: { stanzaId: 'VO1', participant: ALICE, quotedMessage: quotedViewOnce } }));
check('view-once: a second reply does not reveal it again', sent.length === 0, sent);

// A second withheld message that nobody replies to -> the owner is told what to do.
reset();
ws.emit('CB:message', {
  tag: 'message',
  attrs: { from: GROUP, participant: BOB, id: 'VO2', t: String(now()), notify: 'Bob', type: 'media' },
  content: [{ tag: 'unavailable', attrs: { type: 'view_once' }, content: undefined }]
});
ws.emit('CB:message', { tag: 'message', attrs: { from: BOB, id: 'PLAIN', t: String(now()) }, content: [{ tag: 'enc', attrs: {}, content: undefined }] });
console.log('      (waiting 13s for the resend grace period)');
await sleep(13_000);
const notice = sent.find(item => item.content.text?.includes('View-once message received'));
check('view-once: owner is told to reply when the phone does not share it', notice?.jid === ME && notice.content.text.includes('Reply to that message') && notice.content.mentions?.includes(BOB), sent);
check('view-once: no notice for the one already revealed, none for normal messages', sent.length === 1, sent);

// Own view-once messages are left alone; a ".vv" reply is left to the command.
reset();
await upsert(textMsg('RPL3', ALICE, 'mine', undefined, true, { contextInfo: { stanzaId: 'VO3', participant: ME, quotedMessage: quotedViewOnce } }));
check('view-once: own view-once is not "revealed"', sent.length === 0, sent);
await updateSettings({ commands: { enabled: true } });
await registry.loadCommands();
reset();
await upsert(textMsg('RPL4', ALICE, '.vv', undefined, true, { contextInfo: { stanzaId: 'VO4', participant: ALICE, quotedMessage: quotedViewOnce } }), 500);
check('view-once: .vv reveals exactly once (no double send with the reply path)', sent.filter(item => item.content.image).length === 1, sent);

// --- edits -------------------------------------------------------------------------------------
await updateSettings({ antiDelete: { enabled: true }, commands: { enabled: false } });
await upsert(textMsg('E1', ALICE, 'meet at 5'));
reset();
ev.emit('messages.update', [{ key: { remoteJid: ALICE, id: 'E1', fromMe: false }, update: { message: { editedMessage: { message: { conversation: 'meet at 6' } } } } }]);
await sleep(400);
check('edit: before and after are reported', sent[0]?.content.text.includes('meet at 5') && sent[0]?.content.text.includes('meet at 6') && sent[0]?.content.text.includes('Message edited'), sent);
reset();
ev.emit('messages.update', [{ key: { remoteJid: ALICE, id: 'E1', fromMe: false }, update: { message: null, messageStubType: 1 } }]);
await sleep(400);
check('edit: a later deletion recovers the edited text', sent[0]?.content.text.includes('meet at 6') && !sent[0]?.content.text.includes('meet at 5'), sent);

// --- access control ------------------------------------------------------------------------------
await updateSettings({ commands: { enabled: true, mode: 'public', scope: 'all' }, antiDelete: { enabled: false } });
const run = async (text: string, jid: string, from?: string, fromMe = false, extra: object = {}) => {
  reset();
  await upsert(textMsg(`C${++n}`, jid, text, from, fromMe, extra), 450);
  return sent.at(-1)?.content.text as string | undefined;
};
check('public mode: anyone can use commands', (await run('.flip', ALICE))?.match(/Heads|Tails/));
await run('.mode private', ALICE, undefined, true);
check('.mode private switches the setting', getSettings().commands.mode === 'private');
check('private mode: strangers are ignored silently', (await run('.flip', ALICE)) === undefined);
check('private mode: owner still works', (await run('.flip', ALICE, undefined, true))?.match(/Heads|Tails/));
await run('.mode public', ALICE, undefined, true);

await run('.scope groups', ALICE, undefined, true);
check('scope groups: private chat ignored', (await run('.choose a | b', ALICE)) === undefined);
check('scope groups: group works', (await run('.choose a | b', GROUP, BOB))?.includes('I choose'));
await run('.scope all', ALICE, undefined, true);

check('.block by number', (await run('.block 94700000003', ALICE, undefined, true))?.includes('+94700000003 is blocked'));
check('blocked user gets no response', (await run('.rate pizza', GROUP, BOB)) === undefined);
check('other users unaffected', (await run('.rate pizza', GROUP, ALICE))?.includes('/10'));
check('.block refuses owners', (await run('.block 94700000001', ALICE, undefined, true))?.includes('Owners cannot be blocked'));
check('.blocklist shows entries', (await run('.blocklist', ALICE, undefined, true))?.includes('+94700000003'));
await run('.unblock', GROUP, undefined, true, { contextInfo: { mentionedJid: [BOB] } });
check('.unblock by mention', !getSettings().access.blockedUsers.includes('94700000003') && (await run('.rate tea', GROUP, BOB))?.includes('/10'));

await run('.ignore on', GROUP2, ME, true);
check('.ignore on blocks the group', getSettings().access.blockedChats.includes(GROUP2));
check('ignored group: members get nothing', (await run('.flip', GROUP2, ALICE)) === undefined);
check('ignored group: other groups unaffected', (await run('.flip', GROUP, ALICE))?.match(/Heads|Tails/));
await run('.ignore off', GROUP2, ME, true);
check('ignored group: owner can turn it back on from inside', !getSettings().access.blockedChats.includes(GROUP2));

// --- new commands -------------------------------------------------------------------------------
check('.calc', (await run('.calc (2+3)*4', ALICE))?.includes('*20*'));
check('.calc rejects code', (await run('.calc require("fs")', BOB))?.startsWith('❌'));
check('.botinfo shows mode', (await run('.botinfo', ALICE))?.includes('*Mode:* Public'));
reset();
await upsert(textMsg('P1', GROUP, '.poll Lunch? | Pizza | Rice', ALICE), 450);
check('.poll creates a poll', sent.at(-1)?.content.poll?.name === 'Lunch?' && sent.at(-1)?.content.poll.values.length === 2, sent.at(-1));
reset();
await upsert(textMsg('Q1', ALICE, '.qr https://example.com'), 600);
check('.qr sends a PNG image', Buffer.isBuffer(sent.at(-1)?.content.image) && sent.at(-1).content.image.subarray(1, 4).toString() === 'PNG');

(sessions as any).sessions.set('default', fake);
check('.remind confirms', (await run('.remind 2h call mom', GROUP, ALICE))?.includes('remind you at'));
const reminder = await prisma.scheduledJob.findFirst({ where: { name: { startsWith: 'Reminder' } } });
check('.remind creates a one-off job for this chat', reminder?.kind === 'once' && reminder.targets === JSON.stringify([GROUP]) && reminder.text.includes('call mom') && Math.abs(reminder.runAt.getTime() - Date.now() - 7_200_000) < 5000, reminder);
check('.remind validates input', (await run('.remind whenever do it', ADMIN))?.includes('Tell me when'));

check('.warn 1/3', (await run('.warn spam', GROUP, ADMIN, false, { contextInfo: { mentionedJid: [BOB] } }))?.includes('warning 1/3'));
check('.warn refuses admins', (await run('.warn', GROUP, ADMIN, false, { contextInfo: { mentionedJid: [ADMIN] } }))?.includes('Admins cannot be warned'));
check('.warnings lists them', (await run('.warnings', GROUP, ALICE))?.includes('1/3'));
await run('.warn', GROUP, ADMIN, false, { contextInfo: { mentionedJid: [BOB] } });
await run('.warn', GROUP, ADMIN, false, { contextInfo: { mentionedJid: [BOB] } });
check('.warn removes at the limit', sockCalls.some(call => call[0] === 'groupParticipantsUpdate' && call[2][0] === BOB && call[3] === 'remove'), sockCalls);
check('.hidetag mentions everyone silently', (await run('.hidetag meeting at 5', GROUP, ADMIN)) === 'meeting at 5' && sent.at(-1)?.content.mentions.length === 4);
check('.link returns the invite', (await run('.link', GROUP, ADMIN))?.includes('chat.whatsapp.com/OWNINVITECODE123'));
check('.add adds a member', (await run('.add 94711111111', GROUP, ADMIN))?.includes('Added +94711111111'));
check('.add needs an admin', (await run('.add 94711111111', GROUP, ALICE))?.includes('Only group admins'));

// --- auto-replies ---------------------------------------------------------------------------------
await updateSettings({
  autoReply: {
    enabled: true,
    rules: [
      { id: 'r1', enabled: true, trigger: 'price', match: 'contains', response: 'Hi {name}, our price list: example.com/prices', scope: 'private' },
      { id: 'r2', enabled: false, trigger: 'hello', match: 'exact', response: 'disabled rule', scope: 'all' }
    ]
  }
});
check('auto-reply: keyword answered with {name}', (await run('What is the PRICE please', '94700000009@s.whatsapp.net')) === 'Hi Alice, our price list: example.com/prices');
check('auto-reply: scope respected (rule is private-only)', (await run('price?', GROUP, ALICE)) === undefined);
check('auto-reply: disabled rule ignored', (await run('hello', '94700000010@s.whatsapp.net')) === undefined);
check('auto-reply: throttled per chat', (await run('price again', '94700000009@s.whatsapp.net')) === undefined);
check('auto-reply: commands win over rules', (await run('.calc 1+1', '94700000011@s.whatsapp.net'))?.includes('*2*'));

await updateSettings({ autoReply: { enabled: false, awayEnabled: true, awayMessage: 'Away, back soon {name}', awayCooldownMinutes: 60 } });
check('away: private chat gets the away message', (await run('are you there', '94700000012@s.whatsapp.net')) === 'Away, back soon Alice');
await sleep(5200);
check('away: only once per cooldown', (await run('hello??', '94700000012@s.whatsapp.net')) === undefined);
check('away: never in groups', (await run('anyone', GROUP, ALICE)) === undefined);
await updateSettings({ autoReply: { awayEnabled: false } });

// --- calls ----------------------------------------------------------------------------------------
reset();
ev.emit('call', [{ chatId: ALICE, from: ALICE, id: 'CALL1', date: new Date(), status: 'offer', offline: false }]);
await sleep(300);
check('calls: untouched when rejection is off', sockCalls.length === 0);
await updateSettings({ calls: { reject: true, message: 'No calls please' } });
ev.emit('call', [{ chatId: ALICE, from: ALICE, id: 'CALL2', date: new Date(), status: 'offer', offline: false, isVideo: true }]);
ev.emit('call', [{ chatId: ALICE, from: ALICE, id: 'CALL2', date: new Date(), status: 'ringing', offline: false }]);
await sleep(400);
check('calls: declined once', sockCalls.filter(call => call[0] === 'rejectCall').length === 1 && sockCalls[0][1] === 'CALL2', sockCalls);
check('calls: caller gets the message', sent.length === 1 && sent[0].jid === ALICE && sent[0].content.text === 'No calls please', sent);

// --- auto-read ------------------------------------------------------------------------------------
await updateSettings({ general: { autoRead: true } });
reset();
await upsert(textMsg('AR1', BOB, 'ping'));
check('auto-read: marks incoming messages read', sockCalls.some(call => call[0] === 'readMessages'));
await updateSettings({ general: { autoRead: false } });

// --- activity log ---------------------------------------------------------------------------------
await sleep(300);
const feed = await recentActivity('default', 200);
const types = new Set(feed.map((entry: any) => entry.type));
check('activity: feed covers the things that happened', ['viewonce', 'edited', 'deleted', 'command', 'autoreply', 'call'].every(type => types.has(type)), [...types]);
check('activity: newest first with readable titles', feed[0].createdAt >= feed.at(-1).createdAt && feed.some((entry: any) => entry.title.includes('Declined a video call')));
const stats = await activityStats('default');
check('activity: 24h counters', stats.day.command > 10 && stats.day.viewonce >= 2 && stats.week.call === 1, stats);
check('activity: type filter', (await recentActivity('default', 50, 'call')).length === 1);

await scheduler.stop();
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
