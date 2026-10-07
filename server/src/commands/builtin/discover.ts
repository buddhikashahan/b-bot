import { sendMenu, type MenuOption } from '../../features/menus.js';
import { bold, card, field, italic, quote, usage } from '../../whatsapp/format.js';
import type { Command, CommandContext } from '../types.js';
import { LookupError, getJson, getText, lookup } from './info.js';

// Richer look-ups: films and series, crypto prices, news headlines, world clock.
// All from free public services that need no key.

const CINEMETA = 'https://v3-cinemeta.strem.io';
type TitleType = 'movie' | 'series';

interface TitleHit {
  id: string;
  name: string;
  type: TitleType;
  releaseInfo?: string;
}

interface TitleMeta extends TitleHit {
  imdbRating?: string;
  runtime?: string;
  genre?: string[];
  genres?: string[];
  director?: string[];
  cast?: string[];
  description?: string;
  poster?: string;
  country?: string;
  awards?: string;
  year?: string;
}

async function searchTitles(query: string): Promise<TitleHit[]> {
  const find = (type: TitleType) =>
    getJson<{ metas?: TitleHit[] }>(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`, 15_000).then(
      result => (result.metas ?? []).slice(0, 5).map(hit => ({ ...hit, type })),
      () => [] as TitleHit[]
    );
  const [movies, series] = await Promise.all([find('movie'), find('series')]);
  // Interleave so a series with the same name as a film is not buried.
  const merged: TitleHit[] = [];
  for (let index = 0; index < 5; index++) {
    if (movies[index]) merged.push(movies[index]);
    if (series[index]) merged.push(series[index]);
  }
  return merged.slice(0, 8);
}

async function titleMeta(id: string, type?: TitleType): Promise<TitleMeta> {
  for (const kind of type ? [type] : (['movie', 'series'] as const)) {
    const result = await getJson<{ meta?: TitleMeta }>(`${CINEMETA}/meta/${kind}/${id}.json`, 15_000).catch(() => undefined);
    if (result?.meta?.name) return { ...result.meta, type: kind };
  }
  throw new LookupError('I could not load the details for that title.');
}

async function sendTitle(ctx: CommandContext, meta: TitleMeta): Promise<void> {
  const list = (items: string[] | undefined, max: number) => (items?.length ? items.slice(0, max).join(', ') : '');
  const caption = [
    card(meta.type === 'series' ? '📺' : '🎬', `${meta.name}${meta.releaseInfo || meta.year ? ` (${meta.releaseInfo ?? meta.year})` : ''}`, [
      meta.imdbRating ? `⭐ ${field('IMDb', `${meta.imdbRating}/10`)}` : '',
      meta.runtime ? `⏱️ ${field('Runtime', meta.runtime)}` : '',
      list(meta.genre ?? meta.genres, 4) ? `🎭 ${field('Genre', list(meta.genre ?? meta.genres, 4))}` : '',
      list(meta.director, 2) ? `🎬 ${field('Director', list(meta.director, 2))}` : '',
      list(meta.cast, 4) ? `👥 ${field('Cast', list(meta.cast, 4))}` : '',
      meta.country ? `🌍 ${field('Country', meta.country)}` : '',
      meta.awards ? `🏆 ${meta.awards}` : ''
    ]),
    meta.description ? `\n${quote(meta.description.slice(0, 600))}` : '',
    `\n🔗 https://www.imdb.com/title/${meta.id}/`
  ]
    .filter(Boolean)
    .join('\n');

  if (meta.poster) {
    try {
      await ctx.reply({ image: { url: meta.poster }, caption });
      return;
    } catch {
      // Poster host unreachable: the text alone is still useful.
    }
  }
  await ctx.reply(caption);
}

/** Google News RSS, read with a couple of expressions (the feed format is stable and simple). */
function parseFeed(xml: string): { title: string; link: string; source: string; date: string }[] {
  const decode = (text: string) =>
    text
      .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'");
  return [...xml.matchAll(/<item>(.*?)<\/item>/gs)].map(([, item]) => {
    const tag = (name: string) => decode(item.match(new RegExp(`<${name}[^>]*>(.*?)</${name}>`, 's'))?.[1] ?? '').trim();
    const source = tag('source');
    // Titles arrive as "Headline - Publisher"; the publisher is shown separately.
    const title = source && tag('title').endsWith(` - ${source}`) ? tag('title').slice(0, -source.length - 3) : tag('title');
    return { title, link: tag('link'), source, date: tag('pubDate') };
  });
}

export const discoverCommands: Command[] = [
  {
    name: 'imdb',
    aliases: ['movie', 'film', 'series', 'tv'],
    category: 'info',
    description: 'Look up a film or series: rating, cast, plot.',
    usage: 'imdb <title>',
    cooldown: 5,
    execute: lookup(async ctx => {
      const query = ctx.text.trim();
      if (!query) {
        await ctx.reply(usage(ctx.prefix, 'imdb <title>', 'imdb inception'));
        return;
      }
      // "imdb tt1375666 movie" is what a menu choice sends back.
      const direct = query.match(/^(tt\d{6,10})(?:\s+(movie|series))?$/i);
      if (direct) {
        await sendTitle(ctx, await titleMeta(direct[1].toLowerCase(), direct[2]?.toLowerCase() as TitleType | undefined));
        return;
      }
      await ctx.react('🔎');
      const hits = await searchTitles(query);
      if (hits.length === 0) throw new LookupError(`No film or series found for "${query}".`);
      if (hits.length === 1) {
        await sendTitle(ctx, await titleMeta(hits[0].id, hits[0].type));
        return;
      }
      const options: MenuOption[] = hits.map(hit => ({
        label: `${hit.type === 'series' ? '📺' : '🎬'} ${bold(hit.name)}${hit.releaseInfo ? ` ${italic(`(${hit.releaseInfo})`)}` : ''}`,
        action: { type: 'command', text: `imdb ${hit.id} ${hit.type}` }
      }));
      await sendMenu(ctx.bot, ctx.jid, {
        header: card('🎬', 'Films & series', [field('Search', query), field('Results', hits.length)]),
        options,
        footer: quote(italic('Reply with a number to see the details')),
        quoted: ctx.msg
      });
    })
  },
  {
    name: 'crypto',
    aliases: ['coin', 'price'],
    category: 'info',
    description: 'Current price of a cryptocurrency.',
    usage: 'crypto <coin> [currency]',
    cooldown: 5,
    execute: lookup(async ctx => {
      const [coin, currencyArg] = ctx.args;
      if (!coin) {
        await ctx.reply(usage(ctx.prefix, 'crypto <coin> [currency]', 'crypto btc lkr'));
        return;
      }
      const currency = /^[a-z]{3,4}$/i.test(currencyArg ?? '') ? currencyArg.toLowerCase() : 'usd';
      const search = await getJson<{ coins?: { id: string; name: string; symbol: string; market_cap_rank?: number }[] }>(
        `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(coin)}`
      );
      const found = search.coins?.[0];
      if (!found) throw new LookupError(`I do not know a coin called "${coin}".`);
      const prices = await getJson<Record<string, Record<string, number>>>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(found.id)}&vs_currencies=${currency}&include_24hr_change=true&include_market_cap=true`
      );
      const data = prices[found.id];
      const price = data?.[currency];
      if (price === undefined) throw new LookupError(`I have no ${currency.toUpperCase()} price for ${found.name}.`);
      const change = data[`${currency}_24h_change`];
      const money = (value: number) => value.toLocaleString('en', { maximumFractionDigits: value < 1 ? 6 : 2 });
      const cap = data[`${currency}_market_cap`];
      await ctx.reply(
        card('🪙', `${found.name} (${found.symbol.toUpperCase()})`, [
          `💰 ${field('Price', `${money(price)} ${currency.toUpperCase()}`)}`,
          change !== undefined ? `${change >= 0 ? '📈' : '📉'} ${field('24 hours', `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`)}` : '',
          cap ? `🏦 ${field('Market cap', `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(cap)} ${currency.toUpperCase()}`)}` : '',
          found.market_cap_rank ? `🏅 ${field('Rank', `#${found.market_cap_rank}`)}` : ''
        ])
      );
    })
  },
  {
    name: 'news',
    aliases: ['headlines'],
    category: 'info',
    description: 'Latest headlines, optionally about a topic.',
    usage: 'news [topic]',
    cooldown: 10,
    execute: lookup(async ctx => {
      const topic = ctx.text.trim();
      const feed = topic
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en&gl=US&ceid=US:en`
        : 'https://news.google.com/rss?hl=en&gl=US&ceid=US:en';
      const items = parseFeed(await getText(feed, 15_000))
        .filter(item => item.title && item.link)
        .slice(0, 8);
      if (items.length === 0) throw new LookupError(topic ? `No news found about "${topic}".` : 'No headlines available right now.');
      // Each number sends back the link to that story.
      const options: MenuOption[] = items.map(item => ({
        label: `${bold(item.title.slice(0, 140))}\n   ${italic([item.source, item.date.slice(5, 16)].filter(Boolean).join(' · '))}`,
        action: { type: 'text', text: `📰 ${bold(item.title.slice(0, 140))}\n${item.link}` }
      }));
      await sendMenu(ctx.bot, ctx.jid, {
        header: card('📰', topic ? `News: ${topic.slice(0, 40)}` : 'Top headlines', [field('Stories', items.length)]),
        options,
        footer: quote(italic('Reply with a number to get the link to a story')),
        quoted: ctx.msg
      });
    })
  },
  {
    name: 'time',
    aliases: ['clock', 'worldtime'],
    category: 'info',
    description: 'Current time in a city.',
    usage: 'time <city>',
    cooldown: 3,
    execute: lookup(async ctx => {
      const place = ctx.text.trim();
      if (!place) {
        await ctx.reply(usage(ctx.prefix, 'time <city>', 'time Tokyo'));
        return;
      }
      type Geo = { results?: { name: string; country?: string; timezone: string }[] };
      const geo = await getJson<Geo>(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(place)}`);
      const spot = geo.results?.[0];
      if (!spot) throw new LookupError(`I could not find a place called "${place}".`);
      const now = new Date();
      const format = (options: Intl.DateTimeFormatOptions) => now.toLocaleString('en-GB', { timeZone: spot.timezone, ...options });
      await ctx.reply(
        card('🕒', [spot.name, spot.country].filter(Boolean).join(', '), [
          `⏰ ${bold(format({ hour: '2-digit', minute: '2-digit', hour12: true }))}`,
          `📅 ${format({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
          `🌐 ${field('Timezone', `${spot.timezone} (${format({ timeZoneName: 'shortOffset' }).split(' ').pop()})`)}`
        ])
      );
    })
  }
];
