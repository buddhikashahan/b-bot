// Core pipeline: anti-delete, anti-link, greetings, commands and the scheduler.
// Run with `npm test` (scripts/test.mjs gives every suite its own throwaway SQLite database).
import { EventEmitter } from 'node:events';

const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);
const { proto } = await import('@whiskeysockets/baileys');

const { connectDatabase, prisma } = await src('db.ts');
const { loadSettings, updateSettings, getSettings } = await src('settings.ts');
const antiDelete = await src('features/anti-delete.ts');
const guard = await src('features/group-guard.ts');
const utils = await src('whatsapp/message-utils.ts');
const { attachHandlers } = await src('whatsapp/handlers.ts');
const registry = await src('commands/registry.ts');
const { scheduler, normalizeTarget } = await src('scheduler/scheduler.ts');
const { sessions } = await src('whatsapp/session-manager.ts');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 400)}`}`);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

await connectDatabase();
await loadSettings();

const ME = '1000@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const ALICE = '2000@s.whatsapp.net';
const BOB = '3000@s.whatsapp.net';
const ADMIN = '4000@s.whatsapp.net';
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
const failFor = new Set<string>();
let n = 0;
const ev = new EventEmitter();
const fake: any = {
  id: 'default',
  log: { error: (...a: unknown[]) => console.log('  [bot.error]', ...a), debug() {}, info() {}, warn() {} },
  connected: true,
  me: { jid: ME, lid: '9000@lid' },
  sock: {
    ev,
    ws: new EventEmitter(),
    sendMessage: async (jid: string, content: unknown) => void sockCalls.push(['sendMessage', jid, content]),
    groupParticipantsUpdate: async (...args: unknown[]) => void sockCalls.push(['groupParticipantsUpdate', ...args]),
    groupInviteCode: async () => 'OWNINVITECODE123',
    readMessages: async () => {},
    requestPlaceholderResend: async () => {}
  },
  requireSock() {
    return this.sock;
  },
  async send(jid: string, content: unknown) {
    if (failFor.has(jid)) throw new Error('simulated send failure');
    sent.push({ jid, content });
    return { key: { id: `SENT${++n}` }, message: {} };
  },
  download: async () => Buffer.from('x'),
  isSelf: async (jid: string) => jid === ME,
  alertJid: () => ME,
  pnForLid: async () => undefined,
  isOwner: async (ids: string[]) => ids.includes(ME),
  groupMeta: async () => meta,
  listGroups: () => [meta],
  invalidateGroup() {},
  isGroupAdmin: (m: typeof meta, ids: string[]) => m.participants.some(p => p.admin && ids.includes(p.id)),
  botIsAdmin: () => true,
  sentByBot: () => false
};

const now = () => Math.floor(Date.now() / 1000);
const textMsg = (id: string, jid: string, text: string, from?: string, fromMe = false) => ({
  key: { remoteJid: jid, id, fromMe, ...(from ? { participant: from } : {}) },
  message: { conversation: text },
  messageTimestamp: now(),
  pushName: 'Alice'
});

// --- pure helpers ---------------------------------------------------------------------------
check('findLinks: whatsapp mode ignores other links', guard.findLinks('see https://youtube.com/x', 'whatsapp').length === 0);
check('findLinks: whatsapp invite detected', guard.findLinks('join chat.whatsapp.com/AbCdEf123456', 'whatsapp').length === 1);
check('findLinks: all mode catches bare domain', guard.findLinks('visit example.com/page now', 'all').length === 1);
check('findLinks: all mode ignores file.txt / e.g.', guard.findLinks('open file.txt, e.g. this', 'all').length === 0);
check('isWhitelisted: subdomain allowed', guard.isWhitelisted('https://m.youtube.com/watch', ['youtube.com']));
check('isWhitelisted: lookalike rejected', !guard.isWhitelisted('https://notyoutube.com', ['youtube.com']));
check('renderTemplate', guard.renderTemplate('Hi {user} in {group} ({count}) {desc}', meta, ALICE) === 'Hi @2000 in Test Group (4) Be nice');
check('normalizeTarget: phone', normalizeTarget('+1 (555) 123-4567') === '15551234567@s.whatsapp.net');
check('normalizeTarget: group jid', normalizeTarget(GROUP) === GROUP);
check('normalizeTarget: junk', normalizeTarget('hello') === undefined);
check('isViewOnce: v2 wrapper', utils.isViewOnce({ viewOnceMessageV2: { message: { imageMessage: {} } } }));
check('isViewOnce: flag on media', utils.isViewOnce({ videoMessage: { viewOnce: true } }));
check('isViewOnce: normal image', !utils.isViewOnce({ imageMessage: {} }));

// --- anti-delete through the real event wiring ----------------------------------------------
await updateSettings({ antiDelete: { enabled: true }, commands: { enabled: false } });
attachHandlers(fake, fake.sock, () => true);
const upsert = (messages: unknown[]) => ev.emit('messages.upsert', { messages, type: 'notify' });

upsert([textMsg('MSG1', ALICE, 'secret plan at noon')]);
await sleep(400);
check('anti-delete: message cached', (await prisma.cachedMessage.count({ where: { messageId: 'MSG1' } })) === 1);

upsert([textMsg('MINE1', ALICE, 'my own message', undefined, true)]);
await sleep(300);
check('anti-delete: own messages are not cached', (await prisma.cachedMessage.count({ where: { messageId: 'MINE1' } })) === 0);

sent.length = 0;
const revoke = {
  key: { remoteJid: ALICE, id: 'REV1', fromMe: false },
  message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { remoteJid: ALICE, id: 'MSG1', fromMe: false } } },
  messageTimestamp: now()
};
upsert([revoke]);
// Baileys reports the same revoke on messages.update as well.
ev.emit('messages.update', [{ key: { remoteJid: ALICE, id: 'MSG1', fromMe: false }, update: { message: null, messageStubType: 1 } }]);
await sleep(500);
check('anti-delete: exactly one alert for a revoke seen on two events', sent.length === 1, sent);
check('anti-delete: alert goes to alert chat with original text', sent[0]?.jid === ME && sent[0]?.content.text.includes('secret plan at noon'), sent[0]);
check('anti-delete: alert mentions the sender', sent[0]?.content.mentions?.includes(ALICE) && sent[0]?.content.text.includes('@2000'));

await updateSettings({ antiDelete: { groups: false } });
upsert([textMsg('GRP1', GROUP, 'group chatter', BOB)]);
await sleep(300);
check('anti-delete: respects the "groups" toggle', (await prisma.cachedMessage.count({ where: { messageId: 'GRP1' } })) === 0);

await prisma.cachedMessage.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
check('anti-delete: purge removes expired rows', (await antiDelete.purgeExpiredMessages()) >= 1 && (await prisma.cachedMessage.count()) === 0);

// --- anti-link -----------------------------------------------------------------------------
await guard.saveGroupSetting('default', GROUP, {
  antiLink: true,
  antiLinkMode: 'whatsapp',
  antiLinkAction: 'warn',
  warnLimit: 2,
  whitelist: ['https://www.YouTube.com/'],
  welcomeEnabled: true
});
check('whitelist normalised on save', JSON.stringify(guard.parseWhitelist(await guard.getGroupSetting('default', GROUP))) === '["youtube.com"]');

const link = 'join us https://chat.whatsapp.com/SomeOtherGroup99';
sockCalls.length = 0;
sent.length = 0;
check('anti-link: plain text passes', (await guard.handleAntiLink(fake, textMsg('L0', GROUP, 'hello all', ALICE))) === false);
check('anti-link: admin may post links', (await guard.handleAntiLink(fake, textMsg('L1', GROUP, link, ADMIN))) === false);
check("anti-link: group's own invite passes", (await guard.handleAntiLink(fake, textMsg('L2', GROUP, 'chat.whatsapp.com/OWNINVITECODE123', ALICE))) === false);
check('anti-link: nothing deleted so far', sockCalls.length === 0, sockCalls);

check('anti-link: member link removed', (await guard.handleAntiLink(fake, textMsg('L3', GROUP, link, ALICE))) === true);
check('anti-link: message deleted', sockCalls[0]?.[0] === 'sendMessage' && sockCalls[0]?.[2]?.delete?.id === 'L3', sockCalls);
check('anti-link: first warning 1/2', sent.at(-1)?.content.text.includes('Warning 1/2'), sent.at(-1));
await guard.handleAntiLink(fake, textMsg('L4', GROUP, link, ALICE));
const kick = sockCalls.find(call => call[0] === 'groupParticipantsUpdate');
check('anti-link: removed at the warn limit', kick?.[2]?.[0] === ALICE && kick?.[3] === 'remove', sockCalls);
check('anti-link: warnings reset after removal', (await prisma.groupWarning.count()) === 0);

await guard.saveGroupSetting('default', GROUP, { antiLinkMode: 'all' });
check('anti-link: whitelisted site passes in "all" mode', (await guard.handleAntiLink(fake, textMsg('L5', GROUP, 'https://youtube.com/watch?v=1', BOB))) === false);
check('anti-link: other site blocked in "all" mode', (await guard.handleAntiLink(fake, textMsg('L6', GROUP, 'cheap stuff at spam-shop.com', BOB))) === true);

// --- welcome ---------------------------------------------------------------------------------
sent.length = 0;
await guard.handleParticipantsUpdate(fake, { id: GROUP, participants: [{ id: BOB }], action: 'add' });
check('welcome: greets with mention and group name', sent[0]?.content.text.includes('@3000') && sent[0]?.content.text.includes('Test Group') && sent[0]?.content.mentions[0] === BOB, sent);
sent.length = 0;
await guard.handleParticipantsUpdate(fake, { id: GROUP, participants: [{ id: ME }], action: 'add' });
check('welcome: does not greet itself', sent.length === 0);
await guard.handleParticipantsUpdate(fake, { id: GROUP, participants: [{ id: BOB }], action: 'remove' });
check('farewell: silent when disabled', sent.length === 0);

// --- commands --------------------------------------------------------------------------------
await guard.saveGroupSetting('default', GROUP, { antiLink: false });
await updateSettings({ commands: { enabled: true } });
await registry.loadCommands();
const run = async (text: string, jid: string, from?: string, fromMe = false) => {
  sent.length = 0;
  const handled = await registry.handleCommand(fake, textMsg(`C${++n}`, jid, text, from, fromMe));
  return { handled, reply: sent.at(-1)?.content.text as string | undefined };
};
check('command: .ping replies', (await run('.ping', ALICE)).reply?.includes('Pong'));
check('command: cooldown enforced', (await run('.ping', ALICE)).reply?.includes('Slow down'));
check('command: unknown is ignored', (await run('.doesnotexist', ALICE)).handled === false);
check('command: alias + menu lists commands', (await run('.help all', BOB)).reply?.includes('.sticker'));
check('command: menu hides owner-only from others', !(await run('.menu all', '5000@s.whatsapp.net')).reply?.includes('.antidelete'));
check('command: owner-only refused', (await run('.antidelete off', ALICE)).reply?.includes('owner only'));
check('command: group-only refused in DM', (await run('.tagall', ALICE)).reply?.includes('only works in groups'));
check('command: admin-only refused for members', (await run('.kick @x', GROUP, ALICE)).reply?.includes('Only group admins'));
await run('.antidelete off', ALICE, undefined, true);
check('command: owner toggles a setting from their phone', getSettings().antiDelete.enabled === false);
sockCalls.length = 0;
sent.length = 0;
await registry.handleCommand(fake, {
  ...textMsg('K1', GROUP, '.kick', ADMIN),
  message: { extendedTextMessage: { text: '.kick @3000', contextInfo: { mentionedJid: [BOB] } } }
});
check('command: admin kick calls WhatsApp', sockCalls[0]?.[0] === 'groupParticipantsUpdate' && sockCalls[0]?.[2]?.[0] === BOB && sockCalls[0]?.[3] === 'remove', sockCalls);
await updateSettings({ commands: { disabled: ['flip'] } });
check('command: disabled command is ignored', (await run('.flip', BOB)).handled === false);
await updateSettings({ commands: { mode: 'private' } });
check('command: private mode ignores non-owners', (await run('.uptime', BOB)).handled === false);

// --- scheduler: partial failure, retry, no duplicate sends ------------------------------------
const S_ALICE = '200000@s.whatsapp.net';
const S_BOB = '300000@s.whatsapp.net';
(sessions as any).sessions.set('default', fake);
await updateSettings({ broadcast: { minDelayMs: 500, maxDelayMs: 500 } });
await scheduler.start();
const targets = [S_ALICE, S_BOB, GROUP];
const job = await scheduler.create({ name: 'broadcast', kind: 'once', runAt: new Date(Date.now() + 3_600_000), targets, text: 'hello', maxRetries: 2 });
failFor.add(S_BOB);
sent.length = 0;
await scheduler.runNow(job.id);
await sleep(2500);
let row = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: job.id } });
check('scheduler: partial failure keeps the job pending for retry', row.status === 'pending' && row.attempts === 1 && row.nextAttemptAt > new Date(), row);
check('scheduler: progress records delivered targets', JSON.stringify(JSON.parse(row.progress).sort()) === JSON.stringify([S_ALICE, GROUP].sort()), row.progress);
check('scheduler: error names the failed recipient', row.lastError?.includes(S_BOB));
check('scheduler: first pass reached the two healthy targets', sent.map(s => s.jid).sort().join() === [S_ALICE, GROUP].sort().join(), sent);

failFor.clear();
sent.length = 0;
await prisma.scheduledJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date() } });
await (scheduler as any).tick();
row = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: job.id } });
check('scheduler: retry sends only to the missing recipient', sent.length === 1 && sent[0].jid === S_BOB, sent);
check('scheduler: job completes and clears progress', row.status === 'completed' && row.progress === null && row.runCount === 1, row);
const runs = await prisma.jobRun.findMany({ where: { jobId: job.id }, orderBy: { attempt: 'asc' } });
check('scheduler: run history has failed then completed', runs.map((r: any) => r.status).join() === 'failed,completed', runs);

// gives up after maxRetries
const doomed = await scheduler.create({ name: 'doomed', kind: 'once', runAt: new Date(Date.now() + 3_600_000), targets: [S_BOB], text: 'x', maxRetries: 0 });
failFor.add(S_BOB);
await scheduler.runNow(doomed.id);
await sleep(800);
row = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: doomed.id } });
check('scheduler: fails permanently once retries are exhausted', row.status === 'failed' && row.nextAttemptAt === null, row);

// offline: due job waits without burning an attempt
failFor.clear();
fake.connected = false;
const waiting = await scheduler.create({ name: 'waiting', kind: 'once', runAt: new Date(Date.now() - 1000), targets: [S_ALICE], text: 'later', maxRetries: 1 });
await (scheduler as any).tick();
row = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: waiting.id } });
check('scheduler: due job waits while offline (no attempt used)', row.status === 'pending' && row.attempts === 0, row);
fake.connected = true;
sent.length = 0;
await (scheduler as any).tick();
row = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: waiting.id } });
check('scheduler: sends once the connection is back', row.status === 'completed' && sent.length === 1, row);

// crash recovery
await prisma.scheduledJob.update({ where: { id: waiting.id }, data: { status: 'running', progress: null } });
await scheduler.stop();
sent.length = 0;
await scheduler.start();
await sleep(600);
row = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: waiting.id } });
check('scheduler: job interrupted mid-run is resumed on boot', row.status === 'completed' && sent.length === 1, row);

await scheduler.stop();
await prisma.$disconnect();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
