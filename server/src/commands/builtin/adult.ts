import { ADULT_AGE, adultSearchUrl, checkAgeProof, isVerifiedAdult, parseAdultUrl, setVerifiedAdult, takeAttempt } from '../../features/adult.js';
import { getApiKey } from '../../features/ai.js';
import { findUrl, listVideos } from '../../features/downloader.js';
import { parseTargets } from '../../features/forward.js';
import { sendMenu, type MenuOption } from '../../features/menus.js';
import { updateSettings } from '../../settings.js';
import { bold, card, clock, code, fail, field, italic, note, quote, usage } from '../../whatsapp/format.js';
import { contentOf, displayNumber } from '../../whatsapp/message-utils.js';
import type { Command, CommandContext } from '../types.js';
import { allowed, attempt, deliver } from './download.js';

/** The quality videos are fetched in: watchable on a phone without being huge. */
const VIDEO_HEIGHT = 480;
const SEARCH_RESULTS = 8;

/**
 * The gate in front of every 18+ command: switched on, a private chat, and a confirmed adult.
 * Replies and returns false when the command may not run.
 */
async function adultsOnly(ctx: CommandContext): Promise<boolean> {
  if (!ctx.settings.adult.enabled) {
    await ctx.reply(fail('18+ features are switched off', 'The owner can turn them on in the dashboard.'));
    return false;
  }
  // Never in a group, whoever asks: other members did not ask to see it.
  if (ctx.isGroup) {
    await ctx.reply(`🔞 ${bold('Private chats only')}\n${quote('18+ commands do not work in groups. Message me directly.')}`);
    return false;
  }
  if (ctx.isOwner || isVerifiedAdult(ctx.sender)) return true;
  await ctx.reply(`🔞 ${bold('Adults only')}\n${quote(`Confirm your age first: send a photo of your ID card, passport or driving licence with ${code(`${ctx.prefix}verify`)} as its caption.`)}`);
  return false;
}

export const adultCommands: Command[] = [
  {
    name: 'verify',
    aliases: ['ageverify', 'verifyage', 'iam18'],
    category: 'adult',
    description: `Confirm that you are ${ADULT_AGE} or older, to use the 18+ commands. Send a photo of your ID with this as its caption.`,
    usage: 'verify (as the caption of a photo of your ID)',
    cooldown: 5,
    async execute(ctx) {
      if (!ctx.settings.adult.enabled) {
        await ctx.reply(fail('18+ features are switched off', 'There is nothing to verify for.'));
        return;
      }
      if (ctx.isGroup) {
        await ctx.reply(`🔞 ${bold('Not here')}\n${quote('Never post an identity document in a group. Message me directly.')}`);
        return;
      }
      if (ctx.isOwner || isVerifiedAdult(ctx.sender)) {
        await ctx.reply(`✅ ${bold('Already verified')}\n${note('You can use the 18+ commands in this chat.')}`);
        return;
      }
      const own = contentOf(ctx.msg.message)?.imageMessage ? ctx.msg : undefined;
      const source = own ?? (ctx.quoted?.content.imageMessage ? ctx.quoted.message : undefined);
      if (!source) {
        await ctx.reply(
          [
            `🔞 ${bold('Age check')}`,
            quote(`Send a clear photo of your national ID card, passport or driving licence with ${code(`${ctx.prefix}verify`)} as its caption.`),
            note('The photo is read by the AI (Google Gemini) to find your date of birth and is not kept by this bot. Only "verified" is remembered. Delete the photo from this chat afterwards if you like.')
          ].join('\n')
        );
        return;
      }
      if (!(await getApiKey())) {
        await ctx.reply(fail('The age check is not available', 'It needs the AI assistant, which is not set up. Ask the owner to approve you instead.'));
        return;
      }
      if (!takeAttempt(ctx.sender)) {
        await ctx.reply(fail('Too many attempts', 'Try again tomorrow, or ask the owner to approve you.'));
        return;
      }
      await ctx.react('🔎');
      const result = await checkAgeProof(ctx.bot, ctx.jid, await ctx.bot.download(source));
      if (result.adult) {
        await setVerifiedAdult(ctx.sender, true);
        await ctx.react('✅');
        await ctx.reply(`✅ ${bold('Verified')}\n${note(`You can now use the 18+ commands in this chat. See ${ctx.prefix}menu adult.`)}`);
        return;
      }
      await ctx.react('❌');
      const why = {
        'not-a-document': 'That does not look like an identity card, passport or driving licence.',
        unreadable: 'I could not read a date of birth on that. Send a sharper, well-lit photo of the whole document.',
        'under-age': `These commands are for people aged ${ADULT_AGE} and over.`,
        unavailable: 'The check could not run just now. Try again in a little while.'
      }[result.reason];
      await ctx.reply(fail('Not verified', why));
    }
  },
  {
    name: 'adult',
    aliases: ['adults', '18plus'],
    category: 'adult',
    description: 'Owner controls for the 18+ commands: switch them on or off, approve or remove people.',
    usage: 'adult [on | off | allow <number> | revoke <number> | list]',
    ownerOnly: true,
    async execute(ctx) {
      const action = ctx.args[0]?.toLowerCase();
      const { adult } = ctx.settings;
      if (action === 'on' || action === 'off') {
        await updateSettings({ adult: { enabled: action === 'on' } });
        await ctx.reply(action === 'on' ? `🔞 ${bold('18+ commands on')}\n${note('Private chats only, and only for people confirmed as adults.')}` : `🔞 ${bold('18+ commands off')}`);
        return;
      }
      if (action === 'allow' || action === 'approve' || action === 'revoke' || action === 'remove') {
        const { targets } = parseTargets(ctx.args.slice(1).join(' '), ctx.mentions);
        const people = targets.filter(jid => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
        if (people.length === 0) {
          await ctx.reply(usage(ctx.prefix, `adult ${action} <number with country code>`, `adult ${action} 94771234567`));
          return;
        }
        const approve = action === 'allow' || action === 'approve';
        for (const jid of people) await setVerifiedAdult(jid, approve);
        await ctx.reply(`🔞 ${bold(approve ? 'Approved' : 'Removed')}: ${people.map(displayNumber).join(', ')}\n${note(approve ? 'You are vouching that they are adults.' : 'They can no longer use the 18+ commands.')}`);
        return;
      }
      if (action === 'list') {
        await ctx.reply(adult.verified.length ? card('🔞', 'Confirmed adults', adult.verified.map(id => `◦ +${id}`)) : note('Nobody has been confirmed yet.'));
        return;
      }
      await ctx.reply(
        [
          card('🔞', '18+ commands', [field('Status', adult.enabled ? 'On' : 'Off'), field('Confirmed adults', adult.verified.length), field('Works in', 'Private chats only')]),
          note(`${code(`${ctx.prefix}adult on`)} / ${code('off')}, ${code('allow <number>')}, ${code('revoke <number>')}, ${code('list')}. People confirm their own age with ${code(`${ctx.prefix}verify`)}.`)
        ].join('\n')
      );
    }
  },
  {
    name: 'phsearch',
    aliases: ['ph', 'pornhub'],
    category: 'adult',
    description: 'Search Pornhub. Reply with a number to download a result.',
    usage: 'phsearch <words>',
    cooldown: 10,
    async execute(ctx) {
      if (!(await adultsOnly(ctx)) || !(await allowed(ctx))) return;
      const query = ctx.text.trim();
      if (!query) {
        await ctx.reply(usage(ctx.prefix, 'phsearch <words>'));
        return;
      }
      await ctx.react('🔎');
      const results = await attempt(ctx, 'Search failed', () => listVideos(adultSearchUrl(query), SEARCH_RESULTS));
      if (!results) return;
      const found = results.filter(item => parseAdultUrl(item.url));
      if (found.length === 0) {
        await ctx.reply(fail('Nothing found', `No result for "${query}".`));
        return;
      }
      // Titles only: finding each video's length would mean opening every result, which takes many
      // times longer than the search. Text only too: no thumbnails, so nothing explicit appears in
      // the chat list or a notification.
      const options: MenuOption[] = found.map(item => ({
        label: `${bold(item.title.slice(0, 90))}${item.durationSeconds ? `\n   ⏱️ ${clock(item.durationSeconds)}` : ''}`,
        action: { type: 'command', text: `phdl ${item.url}` }
      }));
      await sendMenu(ctx.bot, ctx.jid, {
        header: card('🔞', 'Search results', [field('Query', query), field('Results', found.length)]),
        options,
        footer: quote(italic('Reply with a number to download that video')),
        quoted: ctx.msg,
        style: 'list'
      });
    }
  },
  {
    name: 'phdl',
    aliases: ['phdownload', 'phvideo'],
    category: 'adult',
    description: 'Download a Pornhub video from its link. A big one arrives as a document.',
    usage: 'phdl <link> [doc]',
    cooldown: 20,
    async execute(ctx) {
      if (!(await adultsOnly(ctx)) || !(await allowed(ctx))) return;
      const raw = findUrl(ctx.text) ?? findUrl(ctx.quoted?.text ?? '');
      const url = raw ? parseAdultUrl(raw) : undefined;
      if (!url) {
        await ctx.reply(`${fail('Send a Pornhub link')}\n${usage(ctx.prefix, 'phdl <link> [doc]')}`);
        return;
      }
      const asDocument = /\b(doc|file)\b/i.test(ctx.text.replace(/https?:\/\/\S+/gi, ' '));
      // These are long videos: one too big to play in the chat arrives as a file rather than shrunk.
      await deliver(ctx, url, { kind: 'video', maxHeight: VIDEO_HEIGHT, asDocument, largeAsDocument: true }, '🔞', 'Video');
    }
  }
];
