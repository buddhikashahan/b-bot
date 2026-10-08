// AUTH_STORE=database: WhatsApp credentials and encryption keys kept in the database.
// Run with `npm test` (scripts/test.mjs gives every suite its own throwaway SQLite database).
process.env.AUTH_STORE = 'database';

const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);
const { connectDatabase, prisma } = await src('db.ts');
const { createAuthStore, isPaired } = await src('whatsapp/auth-state.ts');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};

await connectDatabase();

// Count the statements sent to the database: with a hosted database every one is a round trip.
let statements = 0;
for (const method of ['deleteMany', 'createMany', 'upsert', 'findMany'] as const) {
  const original = prisma.authKey[method].bind(prisma.authKey);
  prisma.authKey[method] = (...args: unknown[]) => {
    statements++;
    return original(...args);
  };
}
const counted = async (work: () => Promise<unknown>) => {
  statements = 0;
  await work();
  return statements;
};

const store = await createAuthStore('default');
const { keys } = store.state;
check('a new store starts unpaired, with fresh credentials', !isPaired(store.state.creds) && store.state.creds.noiseKey.private.length === 32);

// What a freshly linked device stores before it uploads its pre-keys to WhatsApp.
const PRE_KEYS = 812;
const pair = (seed: number) => ({ public: Buffer.alloc(32, seed % 251), private: Buffer.alloc(32, (seed * 7) % 251) });
const preKeys = Object.fromEntries(Array.from({ length: PRE_KEYS }, (_, index) => [String(index + 1), pair(index + 1)]));
const started = Date.now();
const bulk = await counted(() => keys.set({ 'pre-key': preKeys }));
check(`${PRE_KEYS} pre-keys are written in a handful of statements, not one each`, bulk <= 12 && (await prisma.authKey.count()) === PRE_KEYS, { statements: bulk, ms: Date.now() - started });

const ids = Object.keys(preKeys);
let read: Record<string, { public: Buffer; private: Buffer }> = {};
const reads = await counted(async () => (read = await keys.get('pre-key', ids)));
check('they are all read back in one query, as bytes', reads === 1 && Object.keys(read).length === PRE_KEYS && Buffer.isBuffer(read['812'].public) && read['812'].private.equals(pair(812).private), reads);
check('unknown ids are simply absent', Object.keys(await keys.get('pre-key', ['99999'])).length === 0);

await keys.set({ 'pre-key': { '5': pair(200), '6': null }, session: { 'alice.0': { some: 'session' } } });
const after = await keys.get('pre-key', ['4', '5', '6']);
check('one call can replace, remove and add keys of several kinds', after['4'].private.equals(pair(4).private) && after['5'].private.equals(pair(200).private) && !('6' in after) && (await keys.get('session', ['alice.0']))['alice.0'].some === 'session' && (await prisma.authKey.count()) === PRE_KEYS, Object.keys(after));
check('replacing a key leaves a single row for it', (await prisma.authKey.count({ where: { category: 'pre-key', keyId: '5' } })) === 1);

// Ids differing only in case are different keys; so are equal ids of different kinds.
await keys.set({ session: { 'ABC.0': { n: 1 }, 'abc.0': { n: 2 } }, 'sender-key': { 'abc.0': { n: 3 } } });
const cased = await keys.get('session', ['ABC.0', 'abc.0']);
check('ids are case-sensitive and separate per kind', cased['ABC.0'].n === 1 && cased['abc.0'].n === 2 && (await keys.get('sender-key', ['abc.0']))['abc.0'].n === 3);

await keys.set({ 'app-state-sync-key': { AAAA: { keyData: Buffer.from('secret'), timestamp: 12 } } });
const syncKey = (await keys.get('app-state-sync-key', ['AAAA'])).AAAA;
check('app state keys come back as protobuf objects', syncKey.constructor.name === 'AppStateSyncKeyData' && Buffer.from(syncKey.keyData).toString() === 'secret');

// Writes issued together must land in the order they were issued.
await Promise.all(Array.from({ length: 25 }, (_, index) => keys.set({ session: { 'race.0': { version: index } } })));
check('overlapping writes to one key keep the last value', (await keys.get('session', ['race.0']))['race.0'].version === 24 && (await prisma.authKey.count({ where: { keyId: 'race.0' } })) === 1);

check('an empty write does nothing', (await counted(() => keys.set({}))) === 0);

store.state.creds.me = { id: '94700000001:1@s.whatsapp.net', name: 'Sam' };
store.state.creds.account = { details: Buffer.from('x') };
await store.saveCreds();
store.state.creds.me.name = 'Sam P';
await store.saveCreds();
const reopened = await createAuthStore('default');
check('credentials survive a restart', isPaired(reopened.state.creds) && reopened.state.creds.me.name === 'Sam P' && Buffer.from(reopened.state.creds.noiseKey.private).equals(Buffer.from(store.state.creds.noiseKey.private)) && (await prisma.authKey.count({ where: { category: 'creds' } })) === 1);
check('and so do the keys', (await reopened.state.keys.get('pre-key', ['5']))['5'].private.equals(pair(200).private));

const other = await createAuthStore('second');
await other.state.keys.set({ 'pre-key': { '1': pair(99) } });
check('sessions do not see each other', (await keys.get('pre-key', ['1']))['1'].private.equals(pair(1).private) && !isPaired(other.state.creds));

// A write that loses a race inside the database is tried again.
const transaction = prisma.$transaction.bind(prisma);
let refusals = 2;
prisma.$transaction = (...args: unknown[]) => (refusals-- > 0 ? Promise.reject(Object.assign(new Error('write conflict'), { code: 'P2034' })) : transaction(...args));
await keys.set({ session: { 'retry.0': { ok: true } } });
check('a write conflict is retried', (await keys.get('session', ['retry.0']))['retry.0']?.ok === true && refusals < 0);
let failed = false;
prisma.$transaction = () => Promise.reject(new Error('database is gone'));
await keys.set({ session: { 'lost.0': { ok: true } } }).catch(() => (failed = true));
prisma.$transaction = transaction;
await keys.set({ session: { 'next.0': { ok: true } } });
check('a failed write is reported and does not block the next one', failed && (await keys.get('session', ['next.0']))['next.0']?.ok === true);

await store.clear();
check('clear wipes this session only', (await prisma.authKey.count({ where: { sessionId: 'default' } })) === 0 && (await prisma.authKey.count({ where: { sessionId: 'second' } })) === 1 && !isPaired((await createAuthStore('default')).state.creds));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
await prisma.$disconnect();
process.exit(failures ? 1 : 0);
