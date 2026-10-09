import { EsanaClient, type NewsArticle } from 'esana-news-sdk';
import { scoped } from '../logger.js';
import { getInternal, getSettings, setInternal, type Settings } from '../settings.js';
import { bold, card, field, italic, quote } from '../whatsapp/format.js';
import type { BotSession } from '../whatsapp/session.js';
import { recordActivity } from './activity.js';
import { remoteThumbnail } from './branding.js';
import { parseMediaUrl } from './downloader.js';
import { sendMenu, type MenuOption } from './menus.js';

// Sri Lankan news from Helakuru Esana (through esana-news-sdk), in Sinhala and English:
// headlines and full stories for the news command, and alerts that post each new story
// to chosen chats as soon as it is published.

const log = scoped('news');

/** Esana's clock: publication times are given in it, and quiet hours are kept in it. */
export const NEWS_TIME_ZONE = 'Asia/Colombo';
const NEWS_UTC_OFFSET = '+05:30';

export type NewsLanguage = Settings['news']['language'];

/** A news story, reduced to what the bot shows. */
export interface Story {
  id: number;
  titleSi: string;
  titleEn: string;
  /** Category id as a string ("2"), see CATEGORIES. */
  category: string;
  published?: Date;
  url: string;
  cover?: string;
  /** Paragraphs of the story, already in WhatsApp markup. */
  textSi: string[];
  textEn: string[];
  /** A recorded statement that comes with the story (MP3). */
  voice?: string;
}

/** Where stories come from. Replaceable so tests need no network. */
export interface NewsSource {
  latest(limit: number, category?: string): Promise<Story[]>;
  top(limit: number): Promise<Story[]>;
  byId(id: number): Promise<Story | undefined>;
  search(query: string, limit: number): Promise<Story[]>;
}

/** A problem worth showing to the person who asked. */
export class NewsError extends Error {}

export const CATEGORIES: Record<string, { name: string; words: string[] }> = {
  '2': { name: 'Incidents', words: ['incidents', 'incident', 'events', 'සිද්ධි'] },
  '3': { name: 'Voice', words: ['voice', 'voices', 'audio', 'හඬපට'] },
  '4': { name: 'Announcements', words: ['announcements', 'announcement', 'notices', 'notice', 'නිවේදන'] },
  '5': { name: 'Statements', words: ['statements', 'statement', 'ප්‍රකාශ'] }
};

/** The category a word names ("notices" is "4"). */
export function categoryOf(word: string): string | undefined {
  const wanted = word.trim().toLowerCase();
  return Object.keys(CATEGORIES).find(id => CATEGORIES[id].words.includes(wanted));
}

// --- from the source's format to ours --------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Story text arrives with a little HTML in it (links, bold); WhatsApp wants its own markup. */
export function toWhatsAppText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => (label.trim() && label.trim() !== href ? `${label.trim()} (${href})` : href))
    .replace(/<(strong|b)>\s*([\s\S]*?)\s*<\/\1>/gi, (_, _tag, text: string) => (text ? `*${text}*` : ''))
    .replace(/<(em|i)>\s*([\s\S]*?)\s*<\/\1>/gi, (_, _tag, text: string) => (text ? `_${text}_` : ''))
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (whole, name: string) => {
      const key = name.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key];
      if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
      return whole;
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function toStory(article: NewsArticle): Story {
  const paragraphs = (blocks: NewsArticle['contentSi']) =>
    (blocks ?? [])
      .filter(block => block.type === 'text' && typeof block.data === 'string')
      .map(block => (block.options?.is_quote ? quote(toWhatsAppText(block.data)) : toWhatsAppText(block.data)))
      .filter(Boolean);
  const voice = [...(article.contentSi ?? []), ...(article.contentEn ?? [])].find(block => block.type === 'voice' && typeof block.data === 'string')?.data;
  // "2026-10-08 20:20:00", in Sri Lanka time.
  const published = article.published ? new Date(`${article.published.replace(' ', 'T')}${NEWS_UTC_OFFSET}`) : undefined;
  return {
    id: Number(article.id),
    titleSi: toWhatsAppText(article.titleSi ?? ''),
    titleEn: toWhatsAppText(article.titleEn ?? ''),
    category: String(article.category ?? ''),
    published: published && !Number.isNaN(published.getTime()) ? published : undefined,
    url: article.share_url || `https://www.helakuru.lk/esana/p/${article.id}/`,
    cover: article.cover || article.thumb || undefined,
    textSi: paragraphs(article.contentSi),
    textEn: paragraphs(article.contentEn),
    voice
  };
}

function esanaSource(): NewsSource {
  let client: EsanaClient | undefined;
  /** When the source's own search index (the stories it has loaded) was last filled. */
  let filledAt = 0;
  const esana = () => (client ??= new EsanaClient({ timeout: 20_000 }));
  const attempt = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      log.warn(`the news service did not answer: ${err instanceof Error ? err.message : err}`);
      throw new NewsError('The news service is not answering right now. Try again in a moment.');
    }
  };
  return {
    latest: (limit, category) => attempt(async () => (await esana().getLatestNews({ limit, ...(category ? { category } : {}) })).articles.map(toStory)),
    top: limit => attempt(async () => (await esana().getTopNews(limit)).map(toStory)),
    byId: id =>
      attempt(async () => {
        const article = await esana().getArticleById(id);
        return article ? toStory(article) : undefined;
      }),
    search: (query, limit) =>
      attempt(async () => {
        // The search looks through stories already loaded, so load a good number first.
        if (Date.now() - filledAt > 5 * 60_000) {
          await esana().getLatestNews({ limit: 80 });
          filledAt = Date.now();
        }
        return (await esana().search(query)).slice(0, limit).map(toStory);
      })
  };
}

let source: NewsSource = esanaSource();
export const news = (): NewsSource => source;
/** Swap the source of stories (tests). */
export function setNewsSource(next: NewsSource): void {
  source = next;
}

// --- showing stories ---------------------------------------------------------------------------------

/** The headline in the wanted language; both: Sinhala with the English under it. */
export function headline(story: Story, language: NewsLanguage): string {
  const si = story.titleSi || story.titleEn;
  const en = story.titleEn || story.titleSi;
  if (language === 'en') return bold(en);
  if (language === 'si' || si === en) return bold(si);
  return `${bold(si)}\n${italic(en)}`;
}

/** "Incidents · 8 Oct, 8:20 pm" */
export function byline(story: Story): string {
  const when = story.published
    ? new Intl.DateTimeFormat('en-GB', { timeZone: NEWS_TIME_ZONE, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(story.published)
    : '';
  return [CATEGORIES[story.category]?.name, when].filter(Boolean).join(' · ');
}

const paragraphsOf = (story: Story, language: NewsLanguage) => (language === 'en' ? (story.textEn.length ? story.textEn : story.textSi) : story.textSi.length ? story.textSi : story.textEn);

/** Whole paragraphs up to about `limit` characters; at least the first one, cut if it must be. */
function lead(paragraphs: string[], limit: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    if (kept.length && length + paragraph.length > limit) break;
    kept.push(paragraph);
    length += paragraph.length;
  }
  const text = kept.join('\n\n');
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** A short version for alerts: headline, the opening of the story, and where to read on. */
export function alertText(story: Story, language: NewsLanguage, prefix: string): string {
  const opening = language === 'both' ? [lead(story.textSi, 320), lead(story.textEn, 320)].filter(Boolean).join('\n\n') : lead(paragraphsOf(story, language), 480);
  return [
    `📰 ${headline(story, language)}`,
    italic(byline(story)),
    opening ? `\n${opening}` : '',
    `\n🔗 ${story.url}`,
    paragraphsOf(story, language).join('').length > opening.length ? quote(italic(`${prefix}news ${story.id} sends the whole story`)) : ''
  ]
    .filter(Boolean)
    .join('\n');
}

/** The whole story. */
export function storyText(story: Story, language: NewsLanguage): string {
  const body = lead(paragraphsOf(story, language), 3400);
  return [`📰 ${headline(story, language)}`, italic(byline(story)), body ? `\n${body}` : story.voice ? `\n${italic('A recorded statement: the audio follows.')}` : '', `\n🔗 ${story.url}`]
    .filter(Boolean)
    .join('\n');
}

/** Stories as a numbered menu: replying with a number sends that story in full. */
export function storyOptions(stories: Story[], language: NewsLanguage): MenuOption[] {
  return stories.map(story => ({
    label: `${headline(story, language).replace(/\n/g, '\n   ')}\n   ${italic(byline(story))}`,
    action: { type: 'command', text: `news ${language} ${story.id}` }
  }));
}

/** The recorded statement of a story, when it has one that is safe and small enough to pass on. */
async function voiceClip(story: Story): Promise<Buffer | undefined> {
  // The address comes from the news service's data, so it gets the same checks as a link in a chat.
  if (!story.voice || !/^https:\/\//i.test(story.voice) || !parseMediaUrl(story.voice)) return undefined;
  try {
    const response = await fetch(story.voice, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 16 * 1024 * 1024) return undefined;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return undefined;
  }
}

/**
 * Post a story to chats: its picture with the text as caption (or just the text), then its
 * recorded statement if it has one. The media is fetched once however many chats there are.
 */
export async function sendStory(bot: BotSession, jids: string[], story: Story, text: string, options: { image: boolean; voice: boolean; quoted?: Parameters<BotSession['send']>[2] }): Promise<number> {
  const image = options.image ? await remoteThumbnail(story.cover, 1280) : undefined;
  const audio = options.voice ? await voiceClip(story) : undefined;
  let delivered = 0;
  for (const [index, jid] of jids.entries()) {
    if (index > 0) await new Promise(resolve => setTimeout(resolve, ALERT_PAUSE_MS));
    try {
      // Captions are short by nature; a long story goes under its picture as a message of its own.
      if (image && text.length <= 1000) await bot.send(jid, { image, caption: text }, options.quoted);
      else {
        if (image) await bot.send(jid, { image, caption: text.split('\n')[0] }, options.quoted);
        await bot.send(jid, { text }, image ? undefined : options.quoted);
      }
      if (audio) await bot.send(jid, { audio, mimetype: 'audio/mpeg' });
      delivered++;
    } catch (err) {
      log.warn({ err }, `could not send a story to ${jid}`);
    }
  }
  return delivered;
}

// --- alerts ----------------------------------------------------------------------------------------

const STATE_KEY = 'newsAlerts';
/** How many story ids to remember as already handled. The service lists far fewer at a time. */
const REMEMBERED = 300;
/** After a long gap (the bot was offline) only the newest few stories are sent, not a flood. */
const MAX_ALERTS_PER_CHECK = 5;
/** A story older than this is no longer an alert. */
const FRESH_FOR_MS = 6 * 60 * 60 * 1000;
const MAX_HELD = 20;
const ALERT_PAUSE_MS = 800;

interface AlertState {
  /** Stories already sent, skipped, or present when alerts were switched on. */
  seen: number[];
  /** Stories published during quiet hours, for the summary that follows them. */
  held: number[];
}

const status: { lastCheckAt: number | null; lastError: string | null; lastStory: { id: number; title: string; at: number } | null; sent: number } = {
  lastCheckAt: null,
  lastError: null,
  lastStory: null,
  sent: 0
};
export const newsStatus = () => ({ ...status });

async function loadState(): Promise<AlertState | undefined> {
  try {
    const stored = await getInternal(STATE_KEY);
    return stored ? (JSON.parse(stored) as AlertState) : undefined;
  } catch {
    return undefined;
  }
}

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Is it quiet hours now, in Sri Lanka time? A span may run over midnight (22:00 to 06:00). */
export function isQuiet(settings: Settings['news'], now = new Date()): boolean {
  if (!settings.quietHours) return false;
  const [hour, minute] = new Intl.DateTimeFormat('en-GB', { timeZone: NEWS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(now).split(':').map(Number);
  const time = (hour % 24) * 60 + minute;
  const from = minutesOf(settings.quietFrom);
  const to = minutesOf(settings.quietTo);
  return from === to ? false : from < to ? time >= from && time < to : time >= from || time < to;
}

let checking = false;

/**
 * Look for stories published since the last look and post them to the alert chats.
 * @returns how many stories were posted
 */
export async function checkNews(bot: BotSession | undefined): Promise<number> {
  const settings = getSettings().news;
  if (!settings.alerts || settings.chats.length === 0) {
    // Forget where we were: switched on again later, alerts start from that moment, not from this one.
    if (await getInternal(STATE_KEY)) await setInternal(STATE_KEY, '');
    return 0;
  }
  if (!bot?.connected || checking) return 0;
  checking = true;
  try {
    const stories = await news().latest(30);
    status.lastCheckAt = Date.now();
    status.lastError = null;
    let state = await loadState();
    if (!state) {
      // Just switched on: everything published so far is old news.
      state = { seen: stories.map(story => story.id), held: [] };
      await setInternal(STATE_KEY, JSON.stringify(state));
      return 0;
    }

    const seen = new Set(state.seen);
    const wanted = (story: Story) => settings.categories.length === 0 || settings.categories.includes(story.category as never);
    const fresh = stories
      .filter(story => !seen.has(story.id) && wanted(story) && (!story.published || Date.now() - story.published.getTime() < FRESH_FOR_MS))
      .sort((a, b) => (a.published?.getTime() ?? 0) - (b.published?.getTime() ?? 0))
      .slice(-MAX_ALERTS_PER_CHECK);
    const quiet = isQuiet(settings);
    const { prefix } = getSettings().commands;
    let posted = 0;

    if (!quiet && state.held.length) {
      // Quiet hours are over: one message with what was published meanwhile.
      const missed = state.held.map(id => stories.find(story => story.id === id)).filter((story): story is Story => Boolean(story));
      if (missed.length) {
        for (const jid of settings.chats) {
          await sendMenu(bot, jid, {
            header: card('🌙', 'While it was quiet', [field('Stories', missed.length)]),
            options: storyOptions(missed, settings.language),
            footer: quote(italic('Reply with a number to read a story'))
          }).catch(err => log.warn({ err }, `could not send the quiet-hours summary to ${jid}`));
        }
        recordActivity(bot.id, 'news', `Sent a summary of ${missed.length} stories published during quiet hours`);
      }
      state.held = [];
    }

    for (const story of fresh) {
      if (quiet) {
        state.held = [...state.held, story.id].slice(-MAX_HELD);
        continue;
      }
      const delivered = await sendStory(bot, settings.chats, story, alertText(story, settings.language, prefix), { image: settings.images, voice: settings.voiceClips });
      if (delivered) {
        posted++;
        status.sent++;
        status.lastStory = { id: story.id, title: story.titleEn || story.titleSi, at: Date.now() };
        recordActivity(bot.id, 'news', `News alert: ${(story.titleEn || story.titleSi).slice(0, 120)}`, { detail: `Sent to ${delivered} of ${settings.chats.length} chats` });
      }
    }

    // Everything listed now counts as handled, also what was filtered out or too old.
    state.seen = [...new Set([...state.seen, ...stories.map(story => story.id)])].slice(-REMEMBERED);
    await setInternal(STATE_KEY, JSON.stringify(state));
    return posted;
  } catch (err) {
    status.lastError = err instanceof NewsError ? err.message : 'Could not check for news.';
    if (!(err instanceof NewsError)) log.error({ err }, 'news check failed');
    return 0;
  } finally {
    checking = false;
  }
}

let timer: NodeJS.Timeout | undefined;

/** Keep checking for news, as often as the settings say. */
export function startNewsAlerts(session: () => BotSession | undefined): void {
  const tick = () => {
    void checkNews(session()).finally(() => {
      timer = setTimeout(tick, getSettings().news.intervalSeconds * 1000);
      timer.unref();
    });
  };
  clearTimeout(timer);
  timer = setTimeout(tick, 15_000);
  timer.unref();
}

export function stopNewsAlerts(): void {
  clearTimeout(timer);
}
