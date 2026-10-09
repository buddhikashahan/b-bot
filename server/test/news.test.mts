// News: the news command, story formatting, and real-time alerts, against a stand-in news source.
// Run with `npm test` (scripts/test.mjs gives every suite its own throwaway SQLite database).
const src = (file: string) => import(new URL(`../src/${file}`, import.meta.url).href);
const { connectDatabase, prisma } = await src('db.ts');
const { loadSettings, updateSettings, getSettings, getInternal } = await src('settings.ts');
const registry = await src('commands/registry.ts');
const feature = await src('features/news.ts');
const { recentActivity } = await src('features/activity.ts');

let failures = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : `\n      ${JSON.stringify(detail)?.slice(0, 700)}`}`);
};

await connectDatabase();
await loadSettings();
await registry.loadCommands();

// --- a stand-in for the news service ------------------------------------------------------------
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const story = (id: number, category: string, minutes: number, extra: object = {}) => ({
  id,
  titleSi: `සිරස්තලය ${id}`,
  titleEn: `Headline ${id}`,
  category,
  published: minutesAgo(minutes),
  url: `https://www.helakuru.lk/esana/p/${id}/`,
  textSi: [`පළමු ඡේදය ${id}.`, 'දෙවන ඡේදය.'],
  textEn: [`First paragraph of ${id}.`, 'Second paragraph.'],
  ...extra
});
let feed = [story(105, '2', 5), story(104, '5', 20), story(103, '4', 40), story(102, '2', 60), story(101, '3', 90)];
let down = false;
const asked: string[] = [];
feature.setNewsSource({
  async latest(limit: number, category?: string) {
    asked.push(`latest ${limit} ${category ?? ''}`.trim());
    if (down) throw new feature.NewsError('The news service is not answering right now. Try again in a moment.');
    return feed.filter(item => !category || item.category === category).slice(0, limit);
  },
  async top(limit: number) {
    asked.push(`top ${limit}`);
    return feed.slice(1, 3).slice(0, limit);
  },
  async byId(id: number) {
    asked.push(`byId ${id}`);
    return feed.find(item => item.id === id);
  },
  async search(query: string, limit: number) {
    asked.push(`search ${query}`);
    return feed.filter(item => item.titleEn.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
  }
});

const ME = '94700000001@s.whatsapp.net';
const ALICE = '94700000002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const CHANNEL = '120363111111111111@newsletter';
const sent: { jid: string; content: any }[] = [];
let n = 0;
const fake: any = {
  id: 'default',
  connected: true,
  me: { jid: ME, name: 'Owner' },
  sock: { sendPresenceUpdate: async () => {} },
  requireSock() {
    return this.sock;
  },
  isOwner: async (ids: string[]) => ids.includes(ME),
  isSelf: async () => false,
  groupMeta: async () => undefined,
  listGroups: () => [{ id: GROUP, subject: 'Family' }],
  isGroupAdmin: () => false,
  botIsAdmin: () => false,
  sentByBot: () => false,
  alertJid: () => ME,
  async send(jid: string, content: any) {
    if (jid === 'broken@g.us') throw new Error('not a member');
    sent.push({ jid, content });
    return { key: { id: `SENT${++n}` }, message: {} };
  }
};
/** Run a command and return what the bot sent. Owners skip cooldowns, so the tests run as one unless told otherwise. */
const run = async (text: string, options: { owner?: boolean; jid?: string } = {}) => {
  sent.length = 0;
  asked.length = 0;
  const owner = options.owner ?? true;
  await registry.handleCommand(fake, { key: { remoteJid: options.jid ?? ALICE, id: `IN${++n}`, fromMe: owner }, message: { conversation: text }, pushName: 'Alice', messageTimestamp: Math.floor(Date.now() / 1000) });
  const texts = sent.map(item => (item.content.text ?? item.content.caption ?? '') as string);
  return { texts, text: texts.join('\n---\n'), sent: [...sent], asked: [...asked] };
};

// --- formatting ------------------------------------------------------------------------------------
check(
  'text: the little HTML in stories becomes WhatsApp markup',
  feature.toWhatsAppText("Visit <a href='https://example.org/doc'>here</a> to read.<br>Next &amp; last &#39;line&#39;") === "Visit here (https://example.org/doc) to read.\nNext & last 'line'" &&
    feature.toWhatsAppText('<strong>"Sir..."</strong> said <em>the lawyer</em> <span class="x">quietly</span>') === '*"Sir..."* said _the lawyer_ quietly' &&
    feature.toWhatsAppText('<a href="https://a.b/c">https://a.b/c</a>') === 'https://a.b/c',
  feature.toWhatsAppText("Visit <a href='https://example.org/doc'>here</a> to read.<br>Next &amp; last &#39;line&#39;")
);
check('categories: named in English or Sinhala', feature.categoryOf('Notices') === '4' && feature.categoryOf('නිවේදන') === '4' && feature.categoryOf('voice') === '3' && feature.categoryOf('sports') === undefined);
const sample = story(200, '2', 0, { published: new Date('2026-10-08T14:50:00Z') });
check('byline: category and the time in Sri Lanka', feature.byline(sample) === 'Incidents · 8 Oct, 8:20 pm', feature.byline(sample));
check('headline: one language, or Sinhala with English under it', feature.headline(sample, 'en') === '*Headline 200*' && feature.headline(sample, 'si') === '*සිරස්තලය 200*' && feature.headline(sample, 'both') === '*සිරස්තලය 200*\n_Headline 200_');
const alert = feature.alertText(story(201, '2', 0, { textEn: ['Opening paragraph.', 'x'.repeat(600)] }), 'en', '.');
check('alert: headline, opening, link, and how to get the rest', alert.startsWith('📰 *Headline 201*\n_Incidents') && alert.includes('\n\nOpening paragraph.\n') && !alert.includes('xxx') && alert.includes('🔗 https://www.helakuru.lk/esana/p/201/') && alert.endsWith('> _.news 201 sends the whole story_'), alert);
check('alert: a short story is not said to continue', !feature.alertText(story(202, '2', 0, { textEn: ['All of it.'] }), 'en', '.').includes('whole story'));
const quiet = { quietHours: true, quietFrom: '22:00', quietTo: '06:00' };
check(
  'quiet hours: kept in Sri Lanka time, also across midnight',
  feature.isQuiet(quiet, new Date('2026-10-08T17:00:00Z')) && feature.isQuiet(quiet, new Date('2026-10-08T23:30:00Z')) && !feature.isQuiet(quiet, new Date('2026-10-08T01:00:00Z')) && !feature.isQuiet(quiet, new Date('2026-10-08T12:00:00Z')) &&
    feature.isQuiet({ quietHours: true, quietFrom: '13:00', quietTo: '15:00' }, new Date('2026-10-08T08:00:00Z')) && !feature.isQuiet({ ...quiet, quietHours: false }, new Date('2026-10-08T17:00:00Z'))
);

// --- the news command ------------------------------------------------------------------------------
const latest = await run('.news');
check('news: the latest stories as a numbered menu, in Sinhala by default', latest.text.includes('*Latest news*') && latest.text.includes('*1.* *සිරස්තලය 105*') && latest.text.includes('*5.* *සිරස්තලය 101*') && latest.text.includes('Reply with a number to read a story') && latest.asked.join() === 'latest 10', latest.text);
const english = await run('.news en');
check('news: a language can be named', english.text.includes('*1.* *Headline 105*') && english.text.includes('_Incidents · '), english.text.slice(0, 300));
const prompt = await prisma.menuPrompt.findFirst({ orderBy: { createdAt: 'desc' } });
const picked = JSON.parse(prompt.options)[1].action.text;
sent.length = 0;
await registry.handleCommand(fake, { key: { remoteJid: ALICE, id: `IN${++n}`, fromMe: false }, message: { conversation: '2' }, pushName: 'Alice' }, picked);
check('news: replying with a number sends that story in full, in the same language', picked === 'news en 104' && sent.length === 1 && sent[0].content.text.startsWith('📰 *Headline 104*\n_Statements') && sent[0].content.text.includes('First paragraph of 104.\n\nSecond paragraph.') && sent[0].content.text.endsWith('🔗 https://www.helakuru.lk/esana/p/104/'), sent.map(item => item.content));
check('news: top stories', (await run('.news top')).asked.join() === 'top 10' && sent[0].content.text.includes('*Top stories*'));
const notices = await run('.news en notices');
check('news: one category', notices.asked.join() === 'latest 10 4' && notices.text.includes('*News: Announcements*') && notices.text.includes('Headline 103') && !notices.text.includes('Headline 105'), notices.text);
const found = await run('.news en search headline 10');
check('news: other words are a search', found.asked.join() === 'search headline 10' && found.text.includes('*News: headline 10*') && found.text.includes('*Stories:* 5'), found.asked);
check('news: nothing found says so', (await run('.news cricket')).text.includes('No recent story mentions "cricket"'));
check('news: an unknown story number says so', (await run('.news 999999')).text.includes('There is no story number 999999'));
down = true;
const failed = await run('.news');
check('news: an outage is explained, once', failed.sent.length === 1 && failed.text.includes('*No news right now*') && failed.text.includes('not answering'), failed.texts);
down = false;
const stranger = await run('.news en', { owner: false });
check('news: anyone may read the news', stranger.text.includes('Headline 105'));
check('worldnews: the international headlines moved to their own command', Boolean(registry.findCommand('worldnews')) && registry.findCommand('headlines')?.name === 'worldnews' && registry.findCommand('news')?.name === 'news');

// --- alerts ----------------------------------------------------------------------------------------
asked.length = 0;
check('alerts: nothing happens while they are off', (await feature.checkNews(fake)) === 0 && asked.length === 0, asked);
await updateSettings({ news: { alerts: true, chats: [GROUP, ALICE], language: 'en', images: false, voiceClips: false } });
sent.length = 0;
check('alerts: switching on sends nothing: what is already published is old news', (await feature.checkNews(fake)) === 0 && sent.length === 0 && JSON.parse(await getInternal('newsAlerts')).seen.length === 5);
check('alerts: nothing new, nothing sent', (await feature.checkNews(fake)) === 0 && sent.length === 0);

feed = [story(106, '5', 1), ...feed];
const posted = await feature.checkNews(fake);
check('alerts: a new story goes to every chosen chat', posted === 1 && sent.map(item => item.jid).join() === [GROUP, ALICE].join() && sent[0].content.text.startsWith('📰 *Headline 106*') && sent[0].content.text.includes('First paragraph of 106.'), sent.map(item => [item.jid, item.content]));
sent.length = 0;
check('alerts: and only once', (await feature.checkNews(fake)) === 0 && sent.length === 0);
check('alerts: the dashboard can see the last alert', feature.newsStatus().lastStory?.id === 106 && feature.newsStatus().sent === 1 && feature.newsStatus().lastError === null);
check('alerts: recorded in the activity feed', (await recentActivity('default', 10, 'news'))[0]?.title === 'News alert: Headline 106');

// Several at once arrive oldest first; stories that are no longer news are skipped.
feed = [story(109, '2', 2), story(108, '4', 4), story(107, '2', 9 * 60), ...feed];
sent.length = 0;
await feature.checkNews(fake);
check('alerts: several new stories arrive oldest first, stale ones not at all', sent.filter(item => item.jid === GROUP).map(item => /Headline (\d+)/.exec(item.content.text)?.[1]).join() === '108,109', sent.map(item => item.content.text.split('\n')[0]));

await updateSettings({ news: { categories: ['4'] } });
feed = [story(111, '4', 1), story(110, '2', 2), ...feed];
sent.length = 0;
await feature.checkNews(fake);
check('alerts: only the chosen topics', sent.length === 2 && sent[0].content.text.includes('Headline 111'), sent.map(item => item.content.text.split('\n')[0]));
feed = [story(110, '2', 2), ...feed.filter(item => item.id !== 110)];
sent.length = 0;
check('alerts: a story that was filtered out does not come back later', (await feature.checkNews(fake)) === 0 && sent.length === 0);
await updateSettings({ news: { categories: [] } });

// After a long gap only the newest few are sent.
feed = [...Array.from({ length: 9 }, (_, index) => story(128 - index, '2', index + 1)), ...feed];
sent.length = 0;
const burst = await feature.checkNews(fake);
check('alerts: a backlog is cut to the newest five', burst === 5 && sent.filter(item => item.jid === GROUP).map(item => /Headline (\d+)/.exec(item.content.text)?.[1]).join() === '124,125,126,127,128', sent.length);

// Quiet hours: nothing is posted, and one summary follows.
const clock = (offsetMinutes: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Date.now() + offsetMinutes * 60_000)).replace(/^24/, '00');
await updateSettings({ news: { quietHours: true, quietFrom: clock(-60), quietTo: clock(60) } });
feed = [story(131, '2', 1), story(130, '5', 2), ...feed];
sent.length = 0;
check('quiet hours: new stories are held back', (await feature.checkNews(fake)) === 0 && sent.length === 0 && JSON.parse(await getInternal('newsAlerts')).held.join() === '130,131');
await updateSettings({ news: { quietHours: false } });
await feature.checkNews(fake);
const summary = sent.find(item => item.jid === GROUP)?.content.text ?? '';
check('quiet hours: afterwards one summary lists what was published', sent.length === 2 && summary.includes('*While it was quiet*') && summary.includes('*1.* *Headline 130*') && summary.includes('*2.* *Headline 131*') && JSON.parse(await getInternal('newsAlerts')).held.length === 0, sent.map(item => item.content.text));
const summaryPrompt = await prisma.menuPrompt.findFirst({ orderBy: { createdAt: 'desc' } });
check('quiet hours: a number in reply to the summary opens that story', JSON.parse(summaryPrompt.options)[0].action.text === 'news en 130');

// Things that go wrong.
down = true;
sent.length = 0;
check('alerts: an outage is noted for the dashboard and nothing breaks', (await feature.checkNews(fake)) === 0 && feature.newsStatus().lastError?.includes('not answering'));
down = false;
feed = [story(140, '2', 1), ...feed];
await updateSettings({ news: { chats: ['broken@g.us'.replace('broken', '120363999999999999'), GROUP] } });
const sendOriginal = fake.send;
fake.send = async (jid: string, content: any) => {
  if (jid.startsWith('120363999999999999')) throw new Error('not a member');
  return sendOriginal.call(fake, jid, content);
};
sent.length = 0;
check('alerts: a chat that cannot be reached does not stop the others', (await feature.checkNews(fake)) === 1 && sent.length === 1 && sent[0].jid === GROUP);
fake.send = sendOriginal;
fake.connected = false;
feed = [story(141, '2', 1), ...feed];
sent.length = 0;
check('alerts: nothing is checked while WhatsApp is disconnected, and nothing is lost', (await feature.checkNews(fake)) === 0 && sent.length === 0);
fake.connected = true;
check('alerts: the story goes out once the connection is back', (await feature.checkNews(fake)) === 1 && sent[0].content.text.includes('Headline 141'));

await updateSettings({ news: { alerts: false } });
await feature.checkNews(fake);
feed = [story(150, '2', 1), ...feed];
await updateSettings({ news: { alerts: true } });
sent.length = 0;
check('alerts: switched off and on again, they start from now', (await feature.checkNews(fake)) === 0 && sent.length === 0);

// --- managing alerts from WhatsApp -------------------------------------------------------------------
await updateSettings({ news: { alerts: false, chats: [], language: 'si' } });
check('newsalerts: owners only', (await run('.newsalerts on', { owner: false })).text.includes('Owner command') && getSettings().news.alerts === false);
const on = await run('.newsalerts on', { jid: GROUP });
check('newsalerts: "on" with no chat chosen starts with this chat', getSettings().news.alerts && getSettings().news.chats.join() === GROUP && on.text.includes('News alerts on'), getSettings().news);
await run(`.newsalerts add 94771234567, ${CHANNEL} 0771234567`);
check('newsalerts: chats, numbers and channels can be added; a number without a country code is not', getSettings().news.chats.join() === [GROUP, '94771234567@s.whatsapp.net', CHANNEL].join(), getSettings().news.chats);
await run('.newsalerts here');
await run('.newsalerts here');
check('newsalerts: "here" adds the chat once', getSettings().news.chats.filter((jid: string) => jid === ALICE).length === 1 && getSettings().news.chats.length === 4);
await run('.newsalerts remove');
await run('.newsalerts remove 94771234567');
check('newsalerts: "remove" takes this chat, or a named one, out', getSettings().news.chats.join() === [GROUP, CHANNEL].join(), getSettings().news.chats);
await run('.newsalerts lang english');
check('newsalerts: the language can be changed', getSettings().news.language === 'en');
const overview = await run('.newsalerts');
check('newsalerts: without words it shows the set-up', overview.text.includes('*Status:* On') && overview.text.includes('*Language:* English') && overview.text.includes('◦ Family') && overview.text.includes('◦ Channel 120363111111111111'), overview.text);
const preview = await run('.newsalerts test');
check('newsalerts: "test" shows an alert here without waiting for news', preview.sent.length === 1 && preview.sent[0].jid === ALICE && preview.text.startsWith('📰 *Headline 150*'), preview.texts);
await run('.newsalerts off');
check('newsalerts: off', getSettings().news.alerts === false);
let rejected = false;
await updateSettings({ news: { chats: ['not a chat'] } }).catch(() => (rejected = true));
check('settings: only real chat IDs can be saved as alert chats', rejected && getSettings().news.chats.length === 2);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
await prisma.$disconnect();
process.exit(failures ? 1 : 0);
