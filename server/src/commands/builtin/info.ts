import { bold, card, code, fail, field, italic, note, quote, usage } from '../../whatsapp/format.js';
import type { Command } from '../types.js';

// Look-ups against free public APIs that need no key. Each call has a short
// timeout so a slow service can never hang a chat.

export class LookupError extends Error {}

export async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'B-Bot/0.3 (self-hosted WhatsApp bot)', Accept: 'application/json' } });
  } catch {
    throw new LookupError('That service did not answer in time. Try again in a moment.');
  }
  if (response.status === 404) throw new LookupError('Nothing found for that.');
  if (!response.ok) throw new LookupError(`That service returned an error (${response.status}).`);
  try {
    return (await response.json()) as T;
  } catch {
    // Some services answer errors in plain text even when asked for JSON.
    throw new LookupError('That service gave an answer I could not read. Try again in a moment.');
  }
}

export async function getText(url: string, timeoutMs = 10_000): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'B-Bot/0.3 (self-hosted WhatsApp bot)' } });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.text()).trim();
  } catch {
    throw new LookupError('That service did not answer. Try again in a moment.');
  }
}

/** Wrap a command body so lookup failures become a tidy reply instead of a stack trace. */
export function lookup(run: Command['execute']): Command['execute'] {
  return async ctx => {
    try {
      await run(ctx);
    } catch (error) {
      if (!(error instanceof LookupError)) throw error;
      await ctx.reply(fail('Could not look that up', error.message));
    }
  };
}

// WMO weather interpretation codes used by Open-Meteo.
const WEATHER: Record<number, string> = {
  0: '☀️ Clear sky',
  1: '🌤️ Mainly clear',
  2: '⛅ Partly cloudy',
  3: '☁️ Overcast',
  45: '🌫️ Fog',
  48: '🌫️ Freezing fog',
  51: '🌦️ Light drizzle',
  53: '🌦️ Drizzle',
  55: '🌧️ Heavy drizzle',
  61: '🌦️ Light rain',
  63: '🌧️ Rain',
  65: '🌧️ Heavy rain',
  66: '🌧️ Freezing rain',
  67: '🌧️ Heavy freezing rain',
  71: '🌨️ Light snow',
  73: '🌨️ Snow',
  75: '❄️ Heavy snow',
  77: '🌨️ Snow grains',
  80: '🌦️ Light showers',
  81: '🌧️ Showers',
  82: '⛈️ Violent showers',
  85: '🌨️ Snow showers',
  86: '❄️ Heavy snow showers',
  95: '⛈️ Thunderstorm',
  96: '⛈️ Thunderstorm with hail',
  99: '⛈️ Severe thunderstorm with hail'
};

export const infoCommands: Command[] = [
  {
    name: 'wiki',
    aliases: ['wikipedia'],
    category: 'info',
    description: 'Get a short summary from Wikipedia.',
    usage: 'wiki <topic>',
    cooldown: 5,
    execute: lookup(async ctx => {
      const topic = ctx.text.trim();
      if (!topic) {
        await ctx.reply(usage(ctx.prefix, 'wiki <topic>', 'wiki Sigiriya'));
        return;
      }
      // Search first so "sri lanka capital" finds the right page title.
      const search = await getJson<{ pages: { key: string }[] }>(
        `https://en.wikipedia.org/w/rest.php/v1/search/page?limit=1&q=${encodeURIComponent(topic)}`
      );
      const key = search.pages[0]?.key;
      if (!key) throw new LookupError(`Wikipedia has no article about "${topic}".`);
      const page = await getJson<{ title: string; description?: string; extract: string; content_urls?: { desktop?: { page?: string } } }>(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`
      );
      await ctx.reply(
        [
          card('📚', page.title, [page.description ? italic(page.description) : '']),
          '',
          quote(page.extract.slice(0, 1200)),
          '',
          `🔗 ${page.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${key}`}`
        ].join('\n')
      );
    })
  },
  {
    name: 'define',
    aliases: ['dict', 'meaning'],
    category: 'info',
    description: 'Look up an English word.',
    usage: 'define <word>',
    cooldown: 5,
    execute: lookup(async ctx => {
      const word = ctx.args[0]?.toLowerCase().replace(/[^a-z'-]/g, '');
      if (!word) {
        await ctx.reply(usage(ctx.prefix, 'define <word>', 'define serendipity'));
        return;
      }
      type Entry = { word: string; phonetic?: string; meanings: { partOfSpeech: string; definitions: { definition: string; example?: string }[] }[] };
      const [entry] = await getJson<Entry[]>(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      const lines = entry.meanings.slice(0, 3).flatMap(meaning => {
        const [first] = meaning.definitions;
        return [`${bold(meaning.partOfSpeech)}`, `- ${first.definition}`, first.example ? `  ${italic(`"${first.example}"`)}` : ''].filter(Boolean);
      });
      await ctx.reply([card('📖', entry.word, [entry.phonetic ? code(entry.phonetic) : '']), '', lines.join('\n')].join('\n'));
    })
  },
  {
    name: 'weather',
    aliases: ['w'],
    category: 'info',
    description: 'Current weather and today\'s forecast for a place.',
    usage: 'weather <city>',
    cooldown: 5,
    execute: lookup(async ctx => {
      const place = ctx.text.trim();
      if (!place) {
        await ctx.reply(usage(ctx.prefix, 'weather <city>', 'weather Colombo'));
        return;
      }
      type Geo = { results?: { name: string; country?: string; admin1?: string; latitude: number; longitude: number; timezone: string }[] };
      const geo = await getJson<Geo>(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(place)}`);
      const spot = geo.results?.[0];
      if (!spot) throw new LookupError(`I could not find a place called "${place}".`);
      type Forecast = {
        current: { temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; wind_speed_10m: number; weather_code: number };
        daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] };
      };
      const forecast = await getJson<Forecast>(
        `https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}` +
          '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code' +
          `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=${encodeURIComponent(spot.timezone)}`
      );
      const { current, daily } = forecast;
      const rain = daily.precipitation_probability_max[0];
      await ctx.reply(
        card('🌍', [spot.name, spot.admin1, spot.country].filter(Boolean).join(', '), [
          WEATHER[current.weather_code] ?? '🌡️ Weather',
          `🌡️ ${field('Now', `${Math.round(current.temperature_2m)}°C`)} ${italic(`feels like ${Math.round(current.apparent_temperature)}°C`)}`,
          `📈 ${field('Today', `${Math.round(daily.temperature_2m_min[0])}°C to ${Math.round(daily.temperature_2m_max[0])}°C`)}`,
          `💧 ${field('Humidity', `${current.relative_humidity_2m}%`)}`,
          `💨 ${field('Wind', `${Math.round(current.wind_speed_10m)} km/h`)}`,
          rain != null ? `☔ ${field('Chance of rain', `${rain}%`)}` : ''
        ])
      );
    })
  },
  {
    name: 'translate',
    aliases: ['tr', 'trt'],
    category: 'info',
    description: 'Translate text (or the message you reply to) into another language.',
    usage: 'translate <language code> <text>',
    cooldown: 5,
    execute: lookup(async ctx => {
      const [target = '', ...rest] = ctx.args;
      const text = rest.join(' ').trim() || ctx.quoted?.text?.trim() || '';
      if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(target) || !text) {
        await ctx.reply(`${usage(ctx.prefix, 'translate <language code> <text>', 'translate si Good morning')}\n${note('Codes: en English, si Sinhala, ta Tamil, hi Hindi, ar Arabic, fr French, es Spanish, ja Japanese...')}`);
        return;
      }
      if (text.length > 450) throw new LookupError('That is too long to translate in one go (450 characters at most).');
      type Translation = { responseData: { translatedText: string }; responseStatus: number | string; matches?: { segment?: string }[] };
      const result = await getJson<Translation>(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`autodetect|${target.toLowerCase()}`)}`
      );
      if (Number(result.responseStatus) !== 200) throw new LookupError(`I could not translate into "${target}". Check the language code.`);
      await ctx.reply([card('🌐', `Translation (${target.toLowerCase()})`, []), '', quote(result.responseData.translatedText)].join('\n'));
    })
  },
  {
    name: 'convert',
    aliases: ['currency', 'fx'],
    category: 'info',
    description: 'Convert an amount between currencies.',
    usage: 'convert <amount> <from> <to>',
    cooldown: 5,
    execute: lookup(async ctx => {
      const match = ctx.text.trim().match(/^([\d.,]+)\s*([a-z]{3})\s*(?:to|in|->)?\s*([a-z]{3})$/i);
      const amount = match ? Number(match[1].replace(/,/g, '')) : NaN;
      if (!match || !Number.isFinite(amount)) {
        await ctx.reply(usage(ctx.prefix, 'convert <amount> <from> <to>', 'convert 100 usd lkr'));
        return;
      }
      const from = match[2].toUpperCase();
      const to = match[3].toUpperCase();
      const data = await getJson<{ result: string; rates?: Record<string, number>; time_last_update_utc?: string }>(`https://open.er-api.com/v6/latest/${from}`);
      const rate = data.rates?.[to];
      if (data.result !== 'success' || !rate) throw new LookupError(`I do not have a rate for ${from} to ${to}.`);
      const money = (value: number) => value.toLocaleString('en', { maximumFractionDigits: value < 10 ? 4 : 2 });
      await ctx.reply(
        card('💱', 'Currency', [
          `${bold(`${money(amount)} ${from}`)} = ${bold(`${money(amount * rate)} ${to}`)}`,
          `📊 ${field('Rate', `1 ${from} = ${money(rate)} ${to}`)}`,
          data.time_last_update_utc ? italic(`Updated ${data.time_last_update_utc.slice(5, 16)}`) : ''
        ])
      );
    })
  },
  {
    name: 'shorten',
    aliases: ['short', 'tiny'],
    category: 'info',
    description: 'Make a long link short.',
    usage: 'shorten <link>',
    cooldown: 5,
    execute: lookup(async ctx => {
      const link = (ctx.text.match(/https?:\/\/\S+/i) ?? ctx.quoted?.text.match(/https?:\/\/\S+/i))?.[0];
      if (!link) {
        await ctx.reply(usage(ctx.prefix, 'shorten <link>', 'shorten https://example.com/a/very/long/address'));
        return;
      }
      // Two independent services, so one being down or rate-limited is not the end of it.
      const short =
        (await getJson<{ shorturl?: string }>(`https://is.gd/create.php?format=json&url=${encodeURIComponent(link)}`).then(
          result => result.shorturl,
          () => undefined
        )) ?? (await getText(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(link)}`));
      if (!/^https?:\/\/\S+$/.test(short)) throw new LookupError('That link could not be shortened.');
      await ctx.reply(card('🔗', 'Short link', [short]));
    })
  },
  {
    name: 'github',
    aliases: ['gh'],
    category: 'info',
    description: 'Show a GitHub user or repository.',
    usage: 'github <user> | <user/repo>',
    cooldown: 5,
    execute: lookup(async ctx => {
      const target = ctx.args[0]?.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
      if (!target || !/^[\w.-]+(\/[\w.-]+)?$/.test(target)) {
        await ctx.reply(usage(ctx.prefix, 'github <user> | <user/repo>', 'github WhiskeySockets/Baileys'));
        return;
      }
      if (target.includes('/')) {
        type Repo = { full_name: string; description?: string; stargazers_count: number; forks_count: number; language?: string; open_issues_count: number; html_url: string; license?: { spdx_id?: string } };
        const repo = await getJson<Repo>(`https://api.github.com/repos/${target}`);
        await ctx.reply(
          card('📦', repo.full_name, [
            repo.description ? italic(repo.description.slice(0, 200)) : '',
            `⭐ ${field('Stars', repo.stargazers_count.toLocaleString('en'))}`,
            `🍴 ${field('Forks', repo.forks_count.toLocaleString('en'))}`,
            `🐞 ${field('Open issues', repo.open_issues_count.toLocaleString('en'))}`,
            repo.language ? `💻 ${field('Language', repo.language)}` : '',
            repo.license?.spdx_id ? `📄 ${field('License', repo.license.spdx_id)}` : '',
            `🔗 ${repo.html_url}`
          ])
        );
        return;
      }
      type User = { login: string; name?: string; bio?: string; public_repos: number; followers: number; following: number; location?: string; html_url: string };
      const user = await getJson<User>(`https://api.github.com/users/${target}`);
      await ctx.reply(
        card('🐙', user.name ? `${user.name} (${user.login})` : user.login, [
          user.bio ? italic(user.bio.slice(0, 200)) : '',
          `📦 ${field('Repositories', user.public_repos)}`,
          `👥 ${field('Followers', user.followers.toLocaleString('en'))}`,
          `➡️ ${field('Following', user.following)}`,
          user.location ? `📍 ${field('Location', user.location)}` : '',
          `🔗 ${user.html_url}`
        ])
      );
    })
  }
];
