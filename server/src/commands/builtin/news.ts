import { isJidGroup } from '@whiskeysockets/baileys';
import { remoteThumbnail } from '../../features/branding.js';
import { MAX_FORWARD_TARGETS, parseTargets } from '../../features/forward.js';
import { sendMenu } from '../../features/menus.js';
import {
  CATEGORIES,
  NewsError,
  alertText,
  categoryOf,
  isQuiet,
  news,
  newsStatus,
  sendStory,
  storyOptions,
  storyText,
  type NewsLanguage,
  type Story
} from '../../features/news.js';
import { updateSettings } from '../../settings.js';
import { bold, card, code, fail, field, italic, note, quote, usage } from '../../whatsapp/format.js';
import { displayNumber } from '../../whatsapp/message-utils.js';
import type { Command, CommandContext } from '../types.js';

const LANGUAGES: Record<string, NewsLanguage> = { si: 'si', sinhala: 'si', සිංහල: 'si', en: 'en', english: 'en', both: 'both' };
const LANGUAGE_NAME: Record<NewsLanguage, string> = { si: 'Sinhala', en: 'English', both: 'Sinhala and English' };
const LIST_SIZE = 10;

/** Run a news step and turn "the service is down" into a reply. */
async function attempt<T>(ctx: CommandContext, work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof NewsError)) throw error;
    await ctx.reply(fail('No news right now', error.message));
    return undefined;
  }
}

async function sendList(ctx: CommandContext, title: string, stories: Story[], language: NewsLanguage): Promise<void> {
  await sendMenu(ctx.bot, ctx.jid, {
    header: card('📰', title, [field('Stories', stories.length), field('Source', 'Helakuru Esana')]),
    options: storyOptions(stories, language),
    footer: quote(italic('Reply with a number to read a story')),
    quoted: ctx.msg,
    image: await remoteThumbnail(stories[0].cover, 1280)
  });
}

/** Names of chats for a list: group subjects where known, numbers otherwise. */
function chatNames(ctx: CommandContext, jids: string[]): string[] {
  const groups = new Map(ctx.bot.listGroups().map(group => [group.id, group.subject]));
  return jids.map(jid => (isJidGroup(jid) ? (groups.get(jid) ?? jid) : jid.endsWith('@newsletter') ? `Channel ${jid.split('@')[0]}` : displayNumber(jid)));
}

export const newsCommands: Command[] = [
  {
    name: 'news',
    aliases: ['esana', 'lknews', 'පුවත්'],
    category: 'info',
    description: 'Latest Sri Lankan news from Helakuru Esana, in Sinhala or English. Reply with a number to read a story.',
    usage: 'news [si|en|both] [top | incidents | voice | notices | statements | <words to search> | <story number>]',
    cooldown: 5,
    async execute(ctx) {
      // An optional first word picks the language for this once; otherwise the dashboard setting decides.
      const chosen = LANGUAGES[ctx.args[0]?.toLowerCase() ?? ''];
      const language = chosen ?? ctx.settings.news.language;
      const words = chosen ? ctx.args.slice(1) : ctx.args;
      const first = words[0]?.toLowerCase() ?? '';

      if (/^\d{3,9}$/.test(first)) {
        const found = await attempt(ctx, async () => ({ story: await news().byId(Number(first)) }));
        if (!found) return;
        if (!found.story) {
          await ctx.reply(fail('Story not found', `There is no story number ${first}. It may have been removed.`));
          return;
        }
        await sendStory(ctx.bot, [ctx.jid], found.story, storyText(found.story, language), { image: true, voice: true, quoted: { quoted: ctx.msg } });
        return;
      }

      const category = words.length === 1 ? categoryOf(first) : undefined;
      const top = words.length === 1 && ['top', 'breaking', 'hot', 'main'].includes(first);
      const query = !category && !top ? words.filter((word, index) => !(index === 0 && word.toLowerCase() === 'search')).join(' ') : '';
      const stories = await attempt(ctx, () => (query ? news().search(query, LIST_SIZE) : top ? news().top(LIST_SIZE) : news().latest(LIST_SIZE, category)));
      if (!stories) return;
      if (stories.length === 0) {
        await ctx.reply(fail('Nothing found', query ? `No recent story mentions "${query}". The search covers the last few days.` : 'There are no stories there right now.'));
        return;
      }
      await sendList(ctx, query ? `News: ${query.slice(0, 40)}` : top ? 'Top stories' : category ? `News: ${CATEGORIES[category].name}` : 'Latest news', stories, language);
    }
  },
  {
    name: 'newsalerts',
    aliases: ['newsalert', 'alerts', 'autonews'],
    category: 'utility',
    description: 'News alerts: post every new story to chosen chats as it is published.',
    usage: 'newsalerts [on | off | here | remove | add <chats> | lang si|en|both | test]',
    ownerOnly: true,
    async execute(ctx) {
      const current = ctx.settings.news;
      const action = ctx.args[0]?.toLowerCase();
      const save = (patch: Partial<typeof current>) => updateSettings({ news: patch });

      if (action === 'on' || action === 'off') {
        if (action === 'on' && current.chats.length === 0) {
          // Switching on with nowhere to send to would do nothing: start with this chat.
          await save({ alerts: true, chats: [ctx.jid] });
          await ctx.reply(`📰 ${bold('News alerts on')}\n${note('New stories will be posted in this chat as they are published.')}`);
          return;
        }
        await save({ alerts: action === 'on' });
        await ctx.reply(action === 'on' ? `📰 ${bold('News alerts on')}\n${note(`New stories go to ${current.chats.length} chat(s) as they are published.`)}` : `📰 ${bold('News alerts off')}`);
        return;
      }
      if (action === 'here' || action === 'add') {
        const { targets, unknown } = action === 'here' ? { targets: [ctx.jid], unknown: [] } : parseTargets(ctx.args.slice(1).join(' '), ctx.mentions);
        if (targets.length === 0) {
          await ctx.reply(`${usage(ctx.prefix, 'newsalerts add <number or chat ID> [more...]')}\n${note(unknown.length ? `Not a chat: ${unknown.slice(0, 5).join(', ')}. Numbers need their country code.` : `Send ${ctx.prefix}jid in a chat to see its ID.`)}`);
          return;
        }
        const chats = [...new Set([...current.chats, ...targets])];
        if (chats.length > MAX_FORWARD_TARGETS * 2) {
          await ctx.reply(fail('Too many chats', 'News alerts can go to at most 50 chats.'));
          return;
        }
        await save({ chats });
        await ctx.reply(`📰 ${bold(`News alerts will go to ${chats.length} chat(s)`)}\n${note(current.alerts ? 'Alerts are on.' : `Alerts are off: send ${ctx.prefix}newsalerts on to start.`)}`);
        return;
      }
      if (action === 'remove' || action === 'stop') {
        const { targets } = parseTargets(ctx.args.slice(1).join(' '), ctx.mentions);
        const gone = targets.length ? targets : [ctx.jid];
        const chats = current.chats.filter(jid => !gone.includes(jid));
        await save({ chats });
        await ctx.reply(chats.length === current.chats.length ? note('That chat was not getting news alerts.') : `📰 ${bold('Removed')}\n${note(`${chats.length} chat(s) still get news alerts.`)}`);
        return;
      }
      if (action === 'lang' || action === 'language') {
        const language = LANGUAGES[ctx.args[1]?.toLowerCase() ?? ''];
        if (!language) {
          await ctx.reply(usage(ctx.prefix, 'newsalerts lang si|en|both'));
          return;
        }
        await save({ language });
        await ctx.reply(`📰 News is now in ${bold(LANGUAGE_NAME[language])}.`);
        return;
      }
      if (action === 'test') {
        const stories = await attempt(ctx, () => news().latest(1));
        if (!stories?.length) return;
        await sendStory(ctx.bot, [ctx.jid], stories[0], alertText(stories[0], current.language, ctx.prefix), { image: current.images, voice: current.voiceClips });
        return;
      }

      const state = newsStatus();
      const names = chatNames(ctx, current.chats);
      await ctx.reply(
        [
          card('📰', 'News alerts', [
            field('Status', current.alerts ? (current.chats.length ? (isQuiet(current) ? 'On, quiet hours now' : 'On') : 'On, but no chat chosen') : 'Off'),
            field('Language', LANGUAGE_NAME[current.language]),
            field('Topics', current.categories.length ? current.categories.map(id => CATEGORIES[id].name).join(', ') : 'Everything'),
            current.quietHours ? field('Quiet hours', `${current.quietFrom} to ${current.quietTo} (Sri Lanka time)`) : '',
            field('Chats', names.length ? names.length : 'None'),
            ...names.slice(0, 15).map(name => `◦ ${name}`),
            state.lastStory ? field('Last alert', state.lastStory.title.slice(0, 80)) : '',
            state.lastError ? `⚠️ ${state.lastError}` : ''
          ]),
          note(`${code(`${ctx.prefix}newsalerts on`)} / ${code('off')}, ${code('here')} adds this chat, ${code('remove')} takes it out, ${code('test')} shows an alert.`)
        ].join('\n')
      );
    }
  }
];
