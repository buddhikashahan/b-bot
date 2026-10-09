import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import { isJidGroup, jidNormalizedUser } from '@whiskeysockets/baileys';
import { phoneOf, setChatBlocked, setUserBlocked } from '../../features/access.js';
import { MAX_FORWARD_TARGETS, forwardable, parseTargets } from '../../features/forward.js';
import { revealViewOnce } from '../../features/view-once.js';
import { getSettings, updateSettings, type SettingsPatch } from '../../settings.js';
import { bold, card, code, fail, field, fileSize, mono, note, usage } from '../../whatsapp/format.js';
import { contentOf, displayNumber, kindOf, mediaOf, userPart } from '../../whatsapp/message-utils.js';
import type { Command, CommandContext } from '../types.js';

/** Pause between two chats when forwarding to several, so it does not arrive as one burst. */
const FORWARD_PAUSE_MS = 700;
/** A chat that does not take the message within this long is reported as failed instead of holding up the rest. */
const FORWARD_TIMEOUT_MS = 30_000;

/**
 * The WhatsApp account behind a phone-number target, which can differ from the number as typed
 * (some countries write numbers one way and register them another).
 * @returns undefined when the number has no account: a typo must not go any further
 */
async function accountOf(ctx: CommandContext, jid: string): Promise<string | undefined> {
  if (!jid.endsWith('@s.whatsapp.net')) return jid;
  try {
    const [found] = (await ctx.sock.onWhatsApp(jid)) ?? [];
    return found?.exists ? jidNormalizedUser(found.jid) : undefined;
  } catch (err) {
    // The look-up itself failed, which says nothing about the number: let the send decide.
    ctx.log.debug({ err }, 'could not check a number before forwarding');
    return jid;
  }
}

function parseToggle(value: string | undefined): boolean | undefined {
  if (['on', 'enable', 'true', '1'].includes(value ?? '')) return true;
  if (['off', 'disable', 'false', '0'].includes(value ?? '')) return false;
  return undefined;
}

/** Owner-only on/off switch backed by a dashboard setting. */
function toggleCommand(
  name: string,
  description: string,
  label: string,
  current: (ctx: CommandContext) => boolean,
  patch: (enabled: boolean) => SettingsPatch
): Command {
  return {
    name,
    category: 'utility',
    description,
    usage: `${name} on|off`,
    ownerOnly: true,
    async execute(ctx) {
      const enabled = parseToggle(ctx.args[0]?.toLowerCase());
      if (enabled === undefined) {
        await ctx.reply(`${label} is *${current(ctx) ? 'on' : 'off'}*.\nUse ${ctx.prefix}${name} on|off`);
        return;
      }
      await updateSettings(patch(enabled));
      await ctx.reply(`${label} is now *${enabled ? 'on' : 'off'}*.`);
    }
  };
}

/** Who a block/unblock command is about: a mention, the quoted author, a typed number, or this private chat. */
async function targetPhone(ctx: CommandContext): Promise<string | undefined> {
  const jid = ctx.mentions[0] ?? ctx.quoted?.sender;
  if (jid) return phoneOf(ctx.bot, jid);
  const typed = ctx.text.replace(/\D/g, '');
  if (/^\d{6,16}$/.test(typed)) return typed;
  return ctx.isGroup ? undefined : phoneOf(ctx.bot, ctx.jid);
}

/** "10m", "2h", "1d12h", "90s" -> milliseconds. */
export function parseDuration(input: string): number | undefined {
  const parts = [...input.toLowerCase().matchAll(/(\d+)\s*(s|m|h|d|w)/g)];
  if (parts.length === 0 || parts.map(part => part[0]).join('').replace(/\s/g, '') !== input.toLowerCase().replace(/\s/g, '')) {
    return undefined;
  }
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return parts.reduce((total, part) => total + Number(part[1]) * unit[part[2] as keyof typeof unit], 0);
}

/** Arithmetic only (+ - * / % ^ and parentheses); never evaluates code. */
export function calculate(expression: string): number {
  const tokens = expression.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/').match(/\d+\.?\d*|\.\d+|[-+*/%^()]/g) ?? [];
  if (tokens.join('') !== expression.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/')) throw new Error('I can only do arithmetic.');
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];

  const primary = (): number => {
    const token = next();
    if (token === '(') {
      const value = sum();
      if (next() !== ')') throw new Error('Missing a closing bracket.');
      return value;
    }
    if (token === '-') return -primary();
    if (token === '+') return primary();
    const value = Number(token);
    if (token === undefined || Number.isNaN(value)) throw new Error('That expression is incomplete.');
    return value;
  };
  const power = (): number => {
    const base = primary();
    return peek() === '^' ? (next(), base ** power()) : base;
  };
  const product = (): number => {
    let value = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const operator = next();
      const right = power();
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
    }
    return value;
  };
  function sum(): number {
    let value = product();
    while (peek() === '+' || peek() === '-') value = next() === '+' ? value + product() : value - product();
    return value;
  }

  const result = sum();
  if (position < tokens.length) throw new Error('I could not read that expression.');
  if (!Number.isFinite(result)) throw new Error('That does not have a finite answer.');
  return result;
}

export const utilityCommands: Command[] = [
  // --- owner controls --------------------------------------------------------------------------
  {
    name: 'mode',
    category: 'utility',
    description: 'Choose who can use the bot: everyone (public) or owners only (private).',
    usage: 'mode public|private',
    ownerOnly: true,
    async execute(ctx) {
      const mode = ctx.args[0]?.toLowerCase();
      if (mode !== 'public' && mode !== 'private') {
        await ctx.reply(`The bot is in *${ctx.settings.commands.mode}* mode.\nUse ${ctx.prefix}mode public|private`);
        return;
      }
      await updateSettings({ commands: { mode } });
      await ctx.reply(mode === 'public' ? '🌍 Public mode: anyone can use commands.' : '🔒 Private mode: only owners can use commands.');
    }
  },
  {
    name: 'scope',
    aliases: ['worktype'],
    category: 'utility',
    description: 'Choose where commands work: everywhere, only groups, or only private chats.',
    usage: 'scope all|groups|private',
    ownerOnly: true,
    async execute(ctx) {
      const scope = ctx.args[0]?.toLowerCase();
      if (scope !== 'all' && scope !== 'groups' && scope !== 'private') {
        await ctx.reply(`Commands currently work in: *${ctx.settings.commands.scope}*.\nUse ${ctx.prefix}scope all|groups|private`);
        return;
      }
      await updateSettings({ commands: { scope } });
      const where = { all: 'everywhere', groups: 'in groups only', private: 'in private chats only' }[scope];
      await ctx.reply(`✅ Commands now work ${where}. Owners can always use them anywhere.`);
    }
  },
  {
    name: 'block',
    aliases: ['ban'],
    category: 'utility',
    description: 'Stop the bot from responding to someone.',
    usage: 'block @user | <number> (or reply to them)',
    ownerOnly: true,
    async execute(ctx) {
      const phone = await targetPhone(ctx);
      if (!phone) {
        await ctx.reply(`Mention someone, reply to their message, or give a number: ${ctx.prefix}block 15551234567`);
        return;
      }
      if (await ctx.bot.isOwner([`${phone}@s.whatsapp.net`])) {
        await ctx.reply('Owners cannot be blocked.');
        return;
      }
      const changed = await setUserBlocked(phone, true);
      await ctx.reply(changed ? `🚫 +${phone} is blocked. I will no longer respond to them.` : `+${phone} is already blocked.`);
    }
  },
  {
    name: 'unblock',
    aliases: ['unban'],
    category: 'utility',
    description: 'Let a blocked person use the bot again.',
    usage: 'unblock @user | <number>',
    ownerOnly: true,
    async execute(ctx) {
      const phone = await targetPhone(ctx);
      if (!phone) {
        await ctx.reply(`Mention someone or give a number: ${ctx.prefix}unblock 15551234567`);
        return;
      }
      const changed = await setUserBlocked(phone, false);
      await ctx.reply(changed ? `✅ +${phone} is unblocked.` : `+${phone} was not blocked.`);
    }
  },
  {
    name: 'blocklist',
    category: 'utility',
    description: 'Show blocked people and ignored groups.',
    ownerOnly: true,
    async execute(ctx) {
      const { blockedUsers, blockedChats } = getSettings().access;
      const groups = new Map(ctx.bot.listGroups().map(group => [group.id, group.subject]));
      await ctx.reply(
        [
          card('🚫', `Blocked people (${blockedUsers.length})`, blockedUsers.length ? blockedUsers.map(phone => `◦ +${phone}`) : ['_none_']),
          '',
          card('🔕', `Ignored groups (${blockedChats.length})`, blockedChats.length ? blockedChats.map(jid => `◦ ${groups.get(jid) ?? jid}`) : ['_none_'])
        ].join('\n')
      );
    }
  },
  {
    name: 'ignore',
    category: 'utility',
    description: 'Make the bot completely inactive in this group (or active again).',
    usage: 'ignore on|off',
    ownerOnly: true,
    groupOnly: true,
    async execute(ctx) {
      const on = parseToggle(ctx.args[0]?.toLowerCase());
      if (on === undefined) {
        const ignored = getSettings().access.blockedChats.includes(ctx.jid);
        await ctx.reply(`This group is ${ignored ? '*ignored*' : '*active*'}.\nUse ${ctx.prefix}ignore on|off`);
        return;
      }
      await setChatBlocked(ctx.jid, on);
      await ctx.reply(
        on
          ? `🔕 I will ignore this group from now on. Send ${ctx.prefix}ignore off from the linked account to bring me back.`
          : '🔔 I am active in this group again.'
      );
    }
  },
  toggleCommand(
    'antidelete',
    'Forward messages that people delete to the alert chat.',
    '🗑️ Anti-delete',
    ctx => ctx.settings.antiDelete.enabled,
    enabled => ({ antiDelete: { enabled } })
  ),
  toggleCommand(
    'viewonce',
    'Reveal incoming view-once media.',
    '👁️ Anti view-once',
    ctx => ctx.settings.viewOnce.enabled,
    enabled => ({ viewOnce: { enabled } })
  ),
  toggleCommand(
    'autostatus',
    "Automatically mark contacts' statuses as viewed.",
    '📣 Auto status view',
    ctx => ctx.settings.status.autoView,
    autoView => ({ status: { autoView } })
  ),
  toggleCommand(
    'anticall',
    'Decline incoming calls automatically.',
    '📵 Call rejection',
    ctx => ctx.settings.calls.reject,
    reject => ({ calls: { reject } })
  ),
  toggleCommand(
    'autoread',
    'Mark every incoming message as read.',
    '✔️ Auto-read',
    ctx => ctx.settings.general.autoRead,
    autoRead => ({ general: { autoRead } })
  ),
  toggleCommand(
    'autoreply',
    'Turn keyword auto-replies on or off.',
    '💬 Auto-replies',
    ctx => ctx.settings.autoReply.enabled,
    enabled => ({ autoReply: { enabled } })
  ),
  {
    name: 'away',
    category: 'utility',
    description: 'Turn the away message on or off, or set its text.',
    usage: 'away on|off|<message>',
    ownerOnly: true,
    async execute(ctx) {
      const toggle = parseToggle(ctx.args.length === 1 ? ctx.args[0].toLowerCase() : undefined);
      if (toggle !== undefined) {
        await updateSettings({ autoReply: { awayEnabled: toggle } });
        await ctx.reply(`🌙 The away message is now *${toggle ? 'on' : 'off'}*.`);
      } else if (ctx.text) {
        await updateSettings({ autoReply: { awayEnabled: true, awayMessage: ctx.text } });
        await ctx.reply('🌙 Away message updated and turned on.');
      } else {
        const { awayEnabled, awayMessage } = ctx.settings.autoReply;
        await ctx.reply(`🌙 The away message is *${awayEnabled ? 'on' : 'off'}*:\n\n${awayMessage}\n\n${ctx.prefix}away on|off|<message>`);
      }
    }
  },
  {
    name: 'setprefix',
    category: 'utility',
    description: 'Change the command prefix.',
    usage: 'setprefix <1-3 characters>',
    ownerOnly: true,
    async execute(ctx) {
      const prefix = ctx.args[0];
      if (!prefix || prefix.length > 3) {
        await ctx.reply(`Current prefix: ${ctx.prefix}\nUse ${ctx.prefix}setprefix <1-3 characters>`);
        return;
      }
      await updateSettings({ commands: { prefix } });
      await ctx.reply(`Prefix changed to ${prefix}`);
    }
  },
  {
    name: 'vv',
    aliases: ['reveal'],
    category: 'utility',
    description: 'Reveal the view-once message you reply to.',
    usage: 'vv [here]',
    ownerOnly: true,
    async execute(ctx) {
      if (!ctx.quoted) {
        await ctx.reply('Reply to a view-once photo, video or voice note with this command.');
        return;
      }
      // Privately by default; "here" posts it back into the chat.
      const destination = ctx.args[0]?.toLowerCase() === 'here' ? ctx.jid : ctx.bot.alertJid();
      const revealed = await revealViewOnce(ctx.bot, ctx.quoted.message, destination);
      if (!revealed) await ctx.reply('That message has no media I can reveal.');
      else await ctx.react('✅');
    }
  },
  {
    name: 'save',
    aliases: ['sv'],
    category: 'utility',
    description: 'Save the message or status you reply to into your alert chat.',
    ownerOnly: true,
    async execute(ctx) {
      const target = ctx.bot.alertJid();
      if (!ctx.quoted || !target) {
        await ctx.reply('Reply to a message or a status with this command.');
        return;
      }
      await ctx.bot.send(target, { forward: ctx.quoted.message });
      await ctx.react('✅');
    }
  },
  {
    name: 'forward',
    aliases: ['fwd', 'fw', 'sendto'],
    category: 'utility',
    description: 'Forward the message you reply to into other chats. Files of any size go at once: nothing is downloaded.',
    usage: 'forward <number or chat ID> [more...]',
    ownerOnly: true,
    async execute(ctx) {
      // What to pass on: the message replied to, or a file sent with this command as its caption.
      const attached = !ctx.quoted && mediaOf(contentOf(ctx.msg.message)) ? forwardable(ctx.msg, true) : undefined;
      const source = ctx.quoted ? forwardable(ctx.quoted.message) : attached;
      const { targets, unknown } = parseTargets(ctx.text, ctx.mentions);
      if (!source || targets.length === 0) {
        await ctx.reply(
          [
            usage(ctx.prefix, 'forward <number or chat ID> [more...]', 'forward 94771234567 120363025246125888@g.us'),
            note(
              source
                ? `Name at least one chat: a number with its country code, or a chat ID (send ${ctx.prefix}jid in a chat to see its ID).`
                : 'Reply to the message to forward, or send a file with this command as its caption. Separate several chats with spaces or commas.'
            ),
            unknown.length ? note(`Not a chat: ${unknown.slice(0, 5).join(', ')}. Numbers need their country code.`) : ''
          ]
            .filter(Boolean)
            .join('\n')
        );
        return;
      }
      if (targets.length > MAX_FORWARD_TARGETS) {
        await ctx.reply(fail('Too many chats at once', `Forward to at most ${MAX_FORWARD_TARGETS} chats per command.`));
        return;
      }

      await ctx.react('⏳');
      const groups = new Map(ctx.bot.listGroups().map(group => [group.id, group.subject]));
      const label = (jid: string) => (isJidGroup(jid) ? (groups.get(jid) ?? jid) : jid.endsWith('@newsletter') ? jid : displayNumber(jid));
      const delivered: string[] = [];
      const failed: string[] = [];
      for (const [index, jid] of targets.entries()) {
        if (index > 0) await new Promise(resolve => setTimeout(resolve, FORWARD_PAUSE_MS));
        let timer: NodeJS.Timeout | undefined;
        try {
          const account = await accountOf(ctx, jid);
          if (!account) {
            failed.push(`${label(jid)} (not on WhatsApp)`);
            continue;
          }
          await Promise.race([
            ctx.bot.send(account, { forward: source }),
            new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), FORWARD_TIMEOUT_MS)))
          ]);
          delivered.push(label(jid));
        } catch (err) {
          ctx.log.warn({ err }, `could not forward to ${jid}`);
          failed.push(label(jid));
        } finally {
          clearTimeout(timer);
        }
      }

      const content = contentOf(source.message);
      const media = mediaOf(content);
      const what = media ? [media.fileName ?? `a ${media.kind}`, media.sizeBytes ? `(${fileSize(media.sizeBytes)})` : ''].filter(Boolean).join(' ') : `a ${kindOf(content)} message`;
      await ctx.react(delivered.length ? '✅' : '❌');
      await ctx.reply(
        [
          card('📨', 'Forwarded', [field('Message', what), field('Sent to', `${delivered.length} of ${targets.length}`), ...delivered.map(name => `✅ ${name}`), ...failed.map(name => `❌ ${name}`)]),
          failed.length ? note('A chat fails when the number is not on WhatsApp or the bot is not in that group.') : '',
          unknown.length ? note(`Skipped, not a chat: ${unknown.slice(0, 5).join(', ')}. Numbers need their country code.`) : ''
        ]
          .filter(Boolean)
          .join('\n')
      );
    }
  },

  // --- everyday tools --------------------------------------------------------------------------
  {
    name: 'remind',
    aliases: ['reminder'],
    category: 'utility',
    description: 'Get a reminder in this chat after some time.',
    usage: 'remind <time> <text>',
    cooldown: 10,
    async execute(ctx) {
      const [when = '', ...rest] = ctx.args;
      const delay = parseDuration(when);
      const note = rest.join(' ').trim();
      if (!delay || !note) {
        await ctx.reply(`Tell me when and what, e.g. ${ctx.prefix}remind 10m take the pizza out\nUnits: s, m, h, d, w (combine like 1h30m).`);
        return;
      }
      if (delay < 10_000 || delay > 90 * 86_400_000) {
        await ctx.reply('Pick a time between 10 seconds and 90 days.');
        return;
      }
      // Imported lazily: the scheduler depends on the session layer, which depends on this registry.
      const { scheduler } = await import('../../scheduler/scheduler.js');
      const runAt = new Date(Date.now() + delay);
      await scheduler.create(
        {
          name: `Reminder: ${note.slice(0, 50)}`,
          kind: 'once',
          runAt,
          targets: [ctx.jid],
          text: `⏰ *Reminder* for @${userPart(ctx.sender)}\n${note}`,
          maxRetries: 3
        },
        ctx.bot.id
      );
      await ctx.reply(`⏰ Okay, I will remind you at ${runAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.`);
    }
  },
  {
    name: 'calc',
    aliases: ['math'],
    category: 'utility',
    description: 'Do some arithmetic.',
    usage: 'calc <sum>',
    cooldown: 2,
    async execute(ctx) {
      if (!ctx.text) {
        await ctx.reply(`Give me something to work out, e.g. ${ctx.prefix}calc (12.5 + 7) * 3`);
        return;
      }
      const result = calculate(ctx.text);
      await ctx.reply(`🧮 ${code(ctx.text.trim())} = ${bold(Number(result.toPrecision(12)))}`);
    }
  },
  {
    name: 'qr',
    category: 'utility',
    description: 'Turn text or a link into a QR code.',
    usage: 'qr <text>',
    cooldown: 5,
    async execute(ctx) {
      const text = ctx.text || ctx.quoted?.text;
      if (!text) {
        await ctx.reply(`Give me some text or a link, e.g. ${ctx.prefix}qr https://example.com`);
        return;
      }
      if (text.length > 1500) {
        await ctx.reply('That is too long for a QR code (1500 characters at most).');
        return;
      }
      await ctx.reply({ image: await QRCode.toBuffer(text, { width: 600, margin: 2 }), caption: text.slice(0, 200) });
    }
  },
  {
    name: 'poll',
    category: 'utility',
    description: 'Create a poll.',
    usage: 'poll <question> | <option> | <option>',
    cooldown: 10,
    async execute(ctx) {
      const [question, ...options] = ctx.text.split('|').map(part => part.trim()).filter(Boolean);
      if (!question || options.length < 2 || options.length > 12) {
        await ctx.reply(`Use ${ctx.prefix}poll Question | Option 1 | Option 2 (2 to 12 options).`);
        return;
      }
      await ctx.send({ poll: { name: question, values: [...new Set(options)], selectableCount: 1 } });
    }
  },
  {
    name: 'genpass',
    aliases: ['password'],
    category: 'utility',
    description: 'Generate a strong random password.',
    usage: 'genpass [length]',
    cooldown: 3,
    async execute(ctx) {
      const length = Math.min(Math.max(Number.parseInt(ctx.args[0] ?? '16', 10) || 16, 8), 64);
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
      const password = Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
      await ctx.reply(`${card('🔐', 'Password', [field('Length', length)])}\n\n${mono(password)}\n\n${note('Made on this server and not stored. Delete this message after copying it.')}`);
    }
  },
  {
    name: 'pp',
    aliases: ['getpp', 'avatar'],
    category: 'utility',
    description: 'Get the profile picture of someone, or of this group.',
    usage: 'pp [@user]',
    cooldown: 5,
    async execute(ctx) {
      const target = ctx.mentions[0] ?? ctx.quoted?.sender ?? (ctx.isGroup && !ctx.args.length ? ctx.jid : ctx.sender);
      const url = await ctx.sock.profilePictureUrl(target, 'image').catch(() => undefined);
      if (!url) {
        await ctx.reply('No profile picture found (it may be hidden by their privacy settings).');
        return;
      }
      await ctx.reply({ image: { url } });
    }
  }
];
