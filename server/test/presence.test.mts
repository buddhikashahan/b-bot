// The "appear online" setting: what the session tells WhatsApp about the account's availability.
// Run with `npm test` (scripts/test.mjs gives every suite its own throwaway SQLite database).
const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);
const { connectDatabase, prisma } = await src('db.ts');
const { loadSettings, updateSettings } = await src('settings.ts');
const { BotSession } = await src('whatsapp/session.ts');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

await connectDatabase();
await loadSettings();

// A connected session with a stand-in socket that records what would go to WhatsApp.
const told: string[] = [];
const creds: { me: { id: string; name?: string } } = { me: { id: '94700000001:1@s.whatsapp.net' } };
const session: any = new BotSession('default');
session.store = { state: { creds } };
session.status = 'connected';
session.sock = {
  sendPresenceUpdate: async (type: string) => void told.push(type),
  sendMessage: async () => ({ key: { id: `M${told.length}` }, message: { conversation: 'hi' } }),
  relayMessage: async () => 'R1'
};

await session.syncPresence();
check('nothing can be said before the account name is known', told.length === 0, told);
creds.me.name = 'Sam';
await session.syncPresence();
check('once the name arrives the account is marked away (the default)', told.join() === 'unavailable', told);
await session.syncPresence();
check('it is not repeated needlessly', told.length === 1, told);

await updateSettings({ general: { markOnline: true } });
await sleep(100);
check('switching "appear online" on takes effect at once', told.join() === 'unavailable,available', told);
await session.send('94700000002@s.whatsapp.net', { text: 'hello' });
await sleep(2400);
check('while online is wanted, sending changes nothing', told.length === 2, told);

await updateSettings({ general: { markOnline: false } });
await sleep(100);
check('switching it off marks the account away at once', told.at(-1) === 'unavailable' && told.length === 3, told);

// WhatsApp shows an account as online when it sends something.
await session.send('94700000002@s.whatsapp.net', { text: 'one' });
await session.send('94700000002@s.whatsapp.net', { text: 'two' });
await session.relay('94700000002@s.whatsapp.net', { conversation: 'three' }, {});
check('away is not re-sent in the middle of a burst', told.length === 3, told);
await sleep(2400);
check('after sending, the account is marked away again, once', told.length === 4 && told.at(-1) === 'unavailable', told);

session.status = 'reconnecting';
await session.send('94700000002@s.whatsapp.net', { text: 'late' }).catch(() => {});
await sleep(2400);
check('nothing is said while disconnected', told.length === 4, told);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
await prisma.$disconnect();
process.exit(failures ? 1 : 0);
