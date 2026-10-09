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
    profilePictureUrl: async () => undefined,
    // Every number has an account except the ones ending in 000, like a mistyped one.
    onWhatsApp: async (jid: string) => (jid.includes('000@') ? [] : [{ jid, exists: true }])
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
  return (sent.at(-1)?.content.text ?? sent.at(-1)?.content.caption) as string | undefined;
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
check('.botinfo carries the cover image', Buffer.isBuffer(sent.at(-1)?.content.image));

await run('.developer', '94700000031@s.whatsapp.net');
const dev = sent[0]?.content.caption as string | undefined;
check('.developer: details card with the cover image, number, website and GitHub', dev?.includes('*Developer*') && dev.includes('*Name:* Buddhika Shahan') && dev.includes('*WhatsApp:* +94766866297') && dev.includes('*Website:* buddhika.dev') && dev.includes('*GitHub:* github.com/buddhikashahan') && Buffer.isBuffer(sent[0]?.content.image), dev);
check('.developer: the contact card follows', sent.length === 2 && sent[1].content.contacts?.contacts[0].vcard.includes('waid=94766866297:+94766866297'), sent.map(item => Object.keys(item.content)));
let editable = true;
await updateSettings({ branding: { developerNumber: '94770000000', developerName: 'Somebody Else' } as never });
await run('.developer', '94700000034@s.whatsapp.net');
editable = !sent[0]?.content.caption?.includes('Buddhika Shahan') || !sent[0].content.caption.includes('+94766866297') || 'developerNumber' in getSettings().branding;
check('.developer: the credit is fixed; settings cannot change it', !editable, { caption: sent[0]?.content.caption, branding: getSettings().branding });
await updateSettings({ branding: { botName: 'Nova', coverOnMenu: false } });
await run('.dev', '94700000032@s.whatsapp.net');
check('.developer: uses the bot name from the settings', sent[0]?.content.text?.includes('Nova v') && sent[0].content.text.includes('Buddhika Shahan'), sent.map(item => item.content));
check('branding: the bot name is used on the menu, without a cover when switched off', (await run('.menu', '94700000033@s.whatsapp.net'))?.includes('🤖 *Nova*') && !sent[0].content.image);
await updateSettings({ branding: { botName: 'B-Bot', coverOnMenu: true } });

// .owner shares the owners named in the dashboard; with none, the linked account.
await run('.owner', '94700000035@s.whatsapp.net');
check('.owner: without owner numbers, the linked account', sent[0]?.content.contacts?.contacts.length === 1 && sent[0].content.contacts.contacts[0].vcard.includes(`waid=${ME.split('@')[0]}:`), sent[0]?.content);
await updateSettings({ general: { ownerNumbers: ['94766866297', '94771112223'] } });
await run('.owner', '94700000036@s.whatsapp.net');
const ownerCards = sent[0]?.content.contacts;
check('.owner: the owner numbers set in the dashboard, one contact each', ownerCards?.contacts.length === 2 && ownerCards.contacts[0].vcard.includes('waid=94766866297:+94766866297') && ownerCards.contacts[1].vcard.includes('waid=94771112223:') && ownerCards.displayName === '2 owners of B-Bot' && !JSON.stringify(ownerCards).includes(ME.split('@')[0]), ownerCards);
await updateSettings({ general: { ownerNumbers: [] } });

// The bot marks its developer's messages in groups.
const DEVELOPER = '94766866297@s.whatsapp.net';
reset();
await upsert({ ...textMsg(`D${++n}`, GROUP, 'hello everyone', DEVELOPER), pushName: 'Buddhika' });
check('developer: a message of theirs in a group gets the reaction', sent.length === 1 && sent[0].jid === GROUP && sent[0].content.react?.text === '👨‍💻' && sent[0].content.react.key.participant === DEVELOPER, sent.map(item => item.content));
reset();
await upsert(textMsg(`D${++n}`, GROUP, 'hello everyone', BOB));
await upsert({ ...textMsg(`D${++n}`, DEVELOPER, 'hello bot'), pushName: 'Buddhika' });
await upsert({ key: { remoteJid: GROUP, id: `D${++n}`, fromMe: false, participant: DEVELOPER }, message: { reactionMessage: { key: { remoteJid: GROUP, id: 'X', fromMe: false }, text: '👍' } }, messageTimestamp: now(), pushName: 'Buddhika' });
check('developer: nobody else, not in private chats, and not for their reactions', !sent.some(item => item.content.react), sent.map(item => item.content));
const realPnForLid = fake.pnForLid;
fake.pnForLid = async (lid: string) => (lid === '555000111222333@lid' ? DEVELOPER : undefined);
reset();
await upsert({ ...textMsg(`D${++n}`, GROUP, 'under a hidden id', '555000111222333@lid'), pushName: 'Buddhika' });
check('developer: also when WhatsApp hides their number in the group', sent.some(item => item.content.react?.text === '👨‍💻'), sent.map(item => item.content));
fake.pnForLid = realPnForLid;

// --- bad language -----------------------------------------------------------------------------------
const { findBadWord } = await src('features/bad-words.ts');
const guard = await src('features/group-guard.ts');
check(
  'bad words: English, also stretched, disguised or spelled out',
  ['what the fuck', 'FUUUUCK off', 'you b!tch', 'sh1t happens', 'f.u.c.k you', 'f u c k', 'motherfucker!!', 'stop being a d1ckhead'].every(text => findBadWord(text)),
  ['what the fuck', 'FUUUUCK off', 'you b!tch', 'sh1t happens', 'f.u.c.k you', 'f u c k', 'motherfucker!!', 'stop being a d1ckhead'].filter(text => !findBadWord(text))
);
check('bad words: Sinhala, in Sinhala letters with endings and in English letters', ['උඹ හුත්තෙක්', 'පකයාට කියපන්', 'ado huththo', 'pakaya wage', 'wesige putha', 'kariyek wage keriya'].every(text => findBadWord(text)), ['උඹ හුත්තෙක්', 'පකයාට කියපන්', 'ado huththo', 'pakaya wage', 'wesige putha', 'kariyek wage keriya'].filter(text => !findBadWord(text)));
check(
  'bad words: ordinary talk is left alone',
  ['good morning class', 'I assess the passage', 'a trip to Niger and Scunthorpe', 'the cockpit and the peacock', 'shitake mushrooms', 'ආයුබෝවන් කොහොමද', 'කැරිබියන් දූපත්', 'mama gedara yanawa', 'as I was saying', 'pass the dictionary'].every(text => !findBadWord(text)),
  ['good morning class', 'I assess the passage', 'a trip to Niger and Scunthorpe', 'the cockpit and the peacock', 'shitake mushrooms', 'ආයුබෝවන් කොහොමද', 'කැරිබියන් දූපත්', 'mama gedara yanawa', 'as I was saying', 'pass the dictionary'].map(text => [text, findBadWord(text)]).filter(([, word]) => word)
);
check('bad words: the owner can add words', !findBadWord('you absolute muppet') && findBadWord('you absolute muppet', ['Muppet']) === 'muppet' && Boolean(findBadWord('මෝඩයා වගේ', ['මෝඩයා'])));

const deletions = () => sockCalls.filter(call => call[0] === 'sendMessage' && call[2]?.delete).length;
const removals = () => sockCalls.filter(call => call[0] === 'groupParticipantsUpdate' && call[3] === 'remove');
reset();
await upsert(textMsg(`W${++n}`, GROUP, 'what the fuck is this', BOB));
check('bad language: nothing happens while the filter is off', deletions() === 0 && sent.length === 0, sent);
await guard.saveGroupSetting('default', GROUP, { antiBadWords: true, badWordAction: 'warn', warnLimit: 3 });
reset();
await upsert(textMsg(`W${++n}`, GROUP, 'what the fuck is this', BOB));
check('bad language: the message is deleted and its sender warned', deletions() === 1 && sent.length === 1 && sent[0].content.text.includes('Warning 1/3') && sent[0].content.mentions[0] === BOB && !sent[0].content.text.includes('fuck'), sent.map(item => item.content));
reset();
await upsert(textMsg(`W${++n}`, GROUP, 'ado huththo', BOB));
check('bad language: Sinhala counts on the same warnings', deletions() === 1 && sent[0]?.content.text.includes('Warning 2/3'), sent.map(item => item.content));
reset();
await upsert(textMsg(`W${++n}`, GROUP, 'good morning all', BOB));
await upsert(textMsg(`W${++n}`, GROUP, 'this is shit', ADMIN));
check('bad language: clean messages and admins are left alone', deletions() === 0 && sent.length === 0, sent.map(item => item.content));
reset();
await upsert(textMsg(`W${++n}`, GROUP, 'bullshit', BOB));
check('bad language: at the limit the member is removed and starts from zero', deletions() === 1 && removals().length === 1 && removals()[0][2][0] === BOB && sent[0].content.text.includes('3/3 warnings') && (await prisma.groupWarning.count({ where: { groupJid: GROUP, userJid: BOB } })) === 0, sent.map(item => item.content));
await guard.saveGroupSetting('default', GROUP, { badWordAction: 'delete' });
reset();
await upsert(textMsg(`W${++n}`, GROUP, 'bitch', ALICE));
check('bad language: "delete" only removes the message', deletions() === 1 && removals().length === 0 && sent[0].content.text.includes('not allowed in this group') && (await prisma.groupWarning.count({ where: { groupJid: GROUP, userJid: ALICE } })) === 0);
await updateSettings({ moderation: { badWords: ['muppet'] } });
reset();
await upsert(textMsg(`W${++n}`, GROUP, 'you muppet', ALICE));
check('bad language: words added in the dashboard are removed too', deletions() === 1);
await updateSettings({ moderation: { badWords: [] } });

reset();
await upsert(textMsg(`W${++n}`, GROUP, '.antibad kick', ADMIN), 450);
check('.antibad: admins choose what happens', (await guard.getGroupSetting('default', GROUP))?.badWordAction === 'kick' && sent.at(-1)?.content.text.includes('action: *kick*'), sent.map(item => item.content));
reset();
await upsert(textMsg(`W${++n}`, GROUP, '.setwarn 5', ADMIN), 450);
check('.setwarn: admins set the number of warnings', (await guard.getGroupSetting('default', GROUP))?.warnLimit === 5 && sent.at(-1)?.content.text.includes('*5* warnings'));
reset();
await upsert(textMsg(`W${++n}`, GROUP, '.antibad off', ALICE), 450);
check('.antibad: members cannot switch it off', (await guard.getGroupSetting('default', GROUP))?.antiBadWords === true && sent.at(-1)?.content.text.includes('Admin command'), sent.map(item => item.content));
reset();
await upsert(textMsg(`W${++n}`, GROUP, '.antibad off', ADMIN), 450);
check('.antibad: off', (await guard.getGroupSetting('default', GROUP))?.antiBadWords === false);
await guard.saveGroupSetting('default', GROUP, { warnLimit: 3 });
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
// Something typed like a command is never answered as if it were conversation.
check('away: a mistyped command gets a hint instead', (await run('.pnig', '94700000013@s.whatsapp.net'))?.includes('Did you mean `.ping`') && sent.length === 1, sent.map(item => item.content));
check('away: an unknown command is left alone', (await run('.zzzzqqq hello', '94700000014@s.whatsapp.net')) === undefined);
await updateSettings({ commands: { mode: 'private' } });
check('away: a command refused by private mode stays silent', (await run('.ping', '94700000015@s.whatsapp.net')) === undefined);
await updateSettings({ commands: { mode: 'public' } });
check('away: a command that runs is answered once, by the command', (await run('.ping', '94700000016@s.whatsapp.net'))?.includes('Pong') && sent.length === 1);
check('away: punctuation that merely starts with the prefix is still conversation', (await run('... hello?', '94700000017@s.whatsapp.net')) === 'Away, back soon Alice');
// What WhatsApp delivers while a message is still being decrypted: a key and nothing else.
reset();
await upsert({ key: { remoteJid: '94700000018@s.whatsapp.net', id: `C${++n}`, fromMe: false }, messageStubType: 2, messageTimestamp: now(), pushName: 'Alice' });
check('away: an empty placeholder message gets no answer', sent.length === 0, sent);
reset();
await upsert({ key: { remoteJid: '94700000018@s.whatsapp.net', id: `C${++n}`, fromMe: false }, message: { reactionMessage: { key: { remoteJid: '94700000018@s.whatsapp.net', id: 'X', fromMe: true }, text: '👍' } }, messageTimestamp: now(), pushName: 'Alice' });
check('away: a reaction gets no answer', sent.length === 0, sent);
check('away: the real message that follows does', (await run('.ping', '94700000018@s.whatsapp.net'))?.includes('Pong') && sent.length === 1);
check('away: and so does ordinary text', (await run('are you around?', '94700000018@s.whatsapp.net')) === 'Away, back soon Alice');
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
// --- forwarding ---------------------------------------------------------------------------------------
const forwarding = await src('features/forward.ts');
const baileys = await import('@whiskeysockets/baileys');
const parsed = forwarding.parseTargets('94771234567, +94 76 686 6297; 120363000000000002@g.us 94700000009@c.us\n(94771234567) hello 0771234567 123 +1 (415) 555-2671 +44 20 7946 0958', ['94700000055:3@s.whatsapp.net']);
check('forward: numbers, formatted numbers, chat IDs and mentions are targets; the rest is reported', parsed.targets.join() === ['94700000055@s.whatsapp.net', '94771234567@s.whatsapp.net', '94766866297@s.whatsapp.net', GROUP2, '94700000009@s.whatsapp.net', '14155552671@s.whatsapp.net', '442079460958@s.whatsapp.net'].join() && parsed.unknown.join() === 'hello,0771234567,123', parsed);
check('forward: several numbers separated by spaces stay separate', forwarding.parseTargets('94771234567 94777654321').targets.length === 2 && forwarding.parseTargets('@94771234567', ['94771234567@s.whatsapp.net']).targets.length === 1 && forwarding.parseTargets('+94 76 686 6297 94771234567').targets.join() === '94766866297@s.whatsapp.net,94771234567@s.whatsapp.net');
const guessed = forwarding.parseTargets('771234567 555-2671 0771234567 94 771234567, 123 94771234567, +372 5123 456');
check('forward: a number without its country code is refused, never guessed at', guessed.targets.join() === ['94771234567@s.whatsapp.net', '3725123456@s.whatsapp.net'].join() && guessed.unknown.join() === '771234567,555-2671,0771234567,123', guessed);

// A 2 GB file as it sits in a WhatsApp message: an address and a key, not the bytes.
const bigFile = {
  documentMessage: {
    url: 'https://mmg.whatsapp.net/v/t62.7119-24/big.enc',
    directPath: '/v/t62.7119-24/big.enc',
    mediaKey: Buffer.alloc(32, 7),
    fileEncSha256: Buffer.alloc(32, 8),
    fileSha256: Buffer.alloc(32, 9),
    fileLength: 2_040_109_465,
    mimetype: 'video/mp4',
    fileName: 'holiday film.mp4',
    caption: 'the whole trip',
    contextInfo: { stanzaId: 'OLDER', participant: BOB, quotedMessage: { conversation: 'an earlier message' } }
  }
};
let downloads = 0;
const realDownload = fake.download;
fake.download = async (...args: unknown[]) => {
  downloads++;
  return realDownload(...args);
};
reset();
await upsert(textMsg(`C${++n}`, ALICE, `.forward 94771234567, ${GROUP} +94 76 686 6297`, undefined, true, { contextInfo: { stanzaId: 'BIG1', participant: ALICE, quotedMessage: bigFile } }), 2400);
const forwards = sent.filter(item => item.content.forward);
check('forward: the message goes to every chat named', forwards.map(item => item.jid).join() === ['94771234567@s.whatsapp.net', GROUP, '94766866297@s.whatsapp.net'].join(), sent.map(item => [item.jid, Object.keys(item.content)]));
check('forward: nothing is downloaded, whatever the size', downloads === 0);
const wire = forwards[0] ? baileys.generateForwardMessageContent(forwards[0].content.forward, forwards[0].content.force) : undefined;
check('forward: what is sent is the same upload with its key, marked as forwarded, without the old reply context', wire?.documentMessage?.url === bigFile.documentMessage.url && Buffer.from(wire.documentMessage.mediaKey).equals(bigFile.documentMessage.mediaKey) && wire.documentMessage.directPath === bigFile.documentMessage.directPath && Number(wire.documentMessage.fileLength) === 2_040_109_465 && wire.documentMessage.caption === 'the whole trip' && wire.documentMessage.contextInfo.isForwarded === true && !wire.documentMessage.contextInfo.quotedMessage, wire?.documentMessage && { ...wire.documentMessage, mediaKey: undefined, fileSha256: undefined, fileEncSha256: undefined });
const summary = sent.find(item => item.content.text?.includes('*Forwarded*'))?.content.text ?? '';
check('forward: the reply says what went where', summary.includes('*Message:* holiday film.mp4 (1.9 GB)') && summary.includes('*Sent to:* 3 of 3') && summary.includes(`✅ ${meta.subject}`) && summary.includes('✅ +94771234567') && summary.includes('✅ +94766866297') && !summary.includes('Skipped'), summary);

reset();
const realSend = fake.send;
fake.send = async (jid: string, content: any) => {
  if (content.forward && jid.startsWith('9477')) throw new Error('not on WhatsApp');
  return realSend.call(fake, jid, content);
};
await upsert(textMsg(`C${++n}`, ALICE, `.fwd 94771234567 ${GROUP2} 94771234000 banana`, undefined, true, { contextInfo: { stanzaId: 'BIG1', participant: ALICE, quotedMessage: { conversation: 'just words' } } }), 2600);
const partial = sent.find(item => item.content.text?.includes('*Forwarded*'))?.content.text ?? '';
check('forward: a chat that fails is reported and does not stop the others', sent.some(item => item.content.forward && item.jid === GROUP2) && partial.includes('*Sent to:* 1 of 3') && partial.includes('❌ +94771234567') && partial.includes('banana') && partial.includes('a text message'), partial);
check('forward: a number with no WhatsApp account is not sent to at all', !sent.some(item => item.jid === '94771234000@s.whatsapp.net') && partial.includes('❌ +94771234000 (not on WhatsApp)'), partial);
fake.send = realSend;

reset();
await upsert({ key: { remoteJid: ALICE, id: `C${++n}`, fromMe: true }, message: { videoMessage: { ...bigFile.documentMessage, fileName: undefined, contextInfo: undefined, caption: `.forward ${GROUP}` } }, messageTimestamp: now(), pushName: 'Me' }, 900);
const own = sent.find(item => item.content.forward)?.content.forward;
check('forward: a file sent with the command as its caption is forwarded without that caption', own?.message.videoMessage.url === bigFile.documentMessage.url && own.message.videoMessage.caption === undefined && sent.filter(item => item.content.forward).length === 1, own?.message.videoMessage && Object.keys(own.message.videoMessage));
check('forward: explains itself without a message or without a chat', (await run('.forward 94771234567', ALICE, undefined, true))?.includes('Reply to the message to forward') && (await run('.forward', ALICE, undefined, true, { contextInfo: { stanzaId: 'BIG1', participant: ALICE, quotedMessage: bigFile } }))?.includes('Name at least one chat'));
// An owner added in the dashboard, writing from their own phone (not the linked account).
const realIsOwner = fake.isOwner;
fake.isOwner = async (ids: string[]) => ids.includes(ME) || ids.includes(BOB);
reset();
await upsert({ ...textMsg(`C${++n}`, BOB, `.forward ${GROUP} 94771234567`, undefined, false, { contextInfo: { stanzaId: 'BIG1', participant: BOB, quotedMessage: bigFile } }), pushName: 'Bob' }, 1800);
check('forward: an added owner can forward from their own chat with the bot', sent.filter(item => item.content.forward).map(item => item.jid).join() === [GROUP, '94771234567@s.whatsapp.net'].join() && sent.some(item => item.jid === BOB && item.content.text?.includes('*Sent to:* 2 of 2')), sent.map(item => [item.jid, Object.keys(item.content)]));
fake.isOwner = realIsOwner;
reset();
await upsert(textMsg(`C${++n}`, ALICE, `.forward ${GROUP}`, undefined, false, { contextInfo: { stanzaId: 'BIG1', participant: ALICE, quotedMessage: bigFile } }), 500);
check('forward: only owners may forward', !sent.some(item => item.content.forward) && sent[0]?.content.text?.includes('Owner command'), sent.map(item => item.content));
fake.download = realDownload;

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
