import { sendMenu, type MenuOption } from '../../features/menus.js';
import { bold, card, code, command, duration, fail, field, italic, note, quote } from '../../whatsapp/format.js';
import { userPart } from '../../whatsapp/message-utils.js';
import { listCommands } from '../registry.js';
import type { Command, CommandCategory, CommandContext } from '../types.js';

type Listed = ReturnType<typeof listCommands>[number];

/** Menu sections in display order. "owner" is not a category: it gathers every owner-only command. */
const SECTIONS: { key: CommandCategory | 'owner'; icon: string; title: string; words: string[] }[] = [
  { key: 'general', icon: '📋', title: 'General', words: ['general', 'main'] },
  { key: 'ai', icon: '🤖', title: 'AI assistant', words: ['ai', 'assistant'] },
  { key: 'download', icon: '📥', title: 'Downloads', words: ['download', 'downloads', 'dl'] },
  { key: 'info', icon: '🔎', title: 'Search & info', words: ['info', 'search'] },
  { key: 'media', icon: '🖼️', title: 'Media', words: ['media', 'sticker'] },
  { key: 'utility', icon: '🧰', title: 'Tools', words: ['tools', 'tool', 'utility'] },
  { key: 'admin', icon: '🛡️', title: 'Group admin', words: ['admin', 'group', 'groups'] },
  { key: 'fun', icon: '🎲', title: 'Fun', words: ['fun', 'games'] },
  { key: 'owner', icon: '👑', title: 'Owner', words: ['owner'] }
];

function inSection(item: Listed, key: CommandCategory | 'owner'): boolean {
  return key === 'owner' ? Boolean(item.ownerOnly) : !item.ownerOnly && item.category === key;
}

/** "`.song` _<name or link>_" */
function signature(prefix: string, item: Listed): string {
  const args = item.usage?.startsWith(item.name) ? item.usage.slice(item.name.length).trim() : '';
  return `${command(prefix, item.name)}${args ? ` ${italic(args)}` : ''}`;
}

function visibleCommands(ctx: CommandContext): Listed[] {
  const disabled = new Set(ctx.settings.commands.disabled);
  return listCommands().filter(item => !disabled.has(item.name) && (!item.ownerOnly || ctx.isOwner));
}

function commandDetails(ctx: CommandContext, item: Listed): string {
  return card('📌', `${ctx.prefix}${item.name}`, [
    item.description,
    item.usage ? `✏️ ${field('Usage', code(`${ctx.prefix}${item.usage}`))}` : '',
    item.aliases?.length ? `🔁 ${field('Also', item.aliases.map(alias => code(`${ctx.prefix}${alias}`)).join(' '))}` : '',
    item.cooldown ? `⏳ ${field('Cooldown', `${item.cooldown}s`)}` : '',
    item.ownerOnly ? '👑 Owner only' : '',
    item.adminOnly ? '🛡️ Group admins only' : item.groupOnly ? '👥 Groups only' : ''
  ]);
}

function menuHeader(ctx: CommandContext, count: number): string {
  const { mode, scope } = ctx.settings.commands;
  const where = { all: 'Everywhere', groups: 'Groups only', private: 'Private chats only' }[scope];
  return card('🤖', 'B-Bot', [
    `👋 Hello, ${bold(ctx.senderName || `+${userPart(ctx.sender)}`)}`,
    `🔑 ${field('Mode', mode === 'public' ? 'Public' : 'Private')}`,
    `📍 ${field('Works in', where)}`,
    `🏷️ ${field('Prefix', code(ctx.prefix))}`,
    `⏱️ ${field('Uptime', duration(process.uptime()))}`,
    `📦 ${field('Commands', count)}`
  ]);
}

export const generalCommands: Command[] = [
  {
    name: 'menu',
    aliases: ['help', 'commands', 'list'],
    category: 'general',
    description: 'Open the menu. Reply with a number to pick a category, then a command.',
    usage: 'menu [all | category | command]',
    cooldown: 3,
    async execute(ctx) {
      const available = visibleCommands(ctx);
      const wanted = ctx.args[0]?.toLowerCase().replace(ctx.prefix, '');
      const sections = SECTIONS.map(section => ({ ...section, items: available.filter(item => inSection(item, section.key)) })).filter(
        section => section.items.length
      );

      // `.menu all`: every command on one page, the way classic bot menus look.
      if (wanted === 'all' || wanted === 'full') {
        await ctx.reply(
          [
            menuHeader(ctx, available.length),
            '',
            sections.map(section => card(section.icon, section.title, section.items.map(item => `◦ ${signature(ctx.prefix, item)}`))).join('\n\n'),
            '',
            quote(`${code(`${ctx.prefix}menu song`)} ${italic('explains one command')}`)
          ].join('\n')
        );
        return;
      }

      if (wanted) {
        const section = sections.find(item => item.words.includes(wanted));
        if (section) {
          // Numbered commands: a reply runs the command when it needs no input, otherwise explains it.
          const options: MenuOption[] = section.items.map(item => ({
            label: `${signature(ctx.prefix, item)}\n   ${italic(item.description)}`,
            action: { type: 'command', text: item.usage?.includes('<') ? `menu ${item.name}` : item.name }
          }));
          await sendMenu(ctx.bot, ctx.jid, {
            header: card(section.icon, section.title, [field('Commands', section.items.length)]),
            options,
            footer: quote(italic('Reply with a number to run or learn about a command')),
            quoted: ctx.msg
          });
          return;
        }
        const item = available.find(entry => entry.name === wanted || entry.aliases?.includes(wanted));
        if (!item) {
          await ctx.reply(fail('Unknown command', `There is no command or category called "${wanted}". Send ${ctx.prefix}menu to see them all.`));
          return;
        }
        await ctx.reply(commandDetails(ctx, item));
        return;
      }

      // Main menu: numbered categories.
      await sendMenu(ctx.bot, ctx.jid, {
        header: menuHeader(ctx, available.length),
        options: sections.map(section => ({
          label: `${section.icon} ${section.title} ${italic(`(${section.items.length})`)}`,
          action: { type: 'command', text: `menu ${section.words[0]}` }
        })),
        footer: quote(`${italic('Reply to this message with a number to open a category')}\n${code(`${ctx.prefix}menu all`)} ${italic('lists every command')}`),
        quoted: ctx.msg
      });
    }
  },
  {
    name: 'ping',
    aliases: ['speed'],
    category: 'general',
    description: 'Check that the bot is alive and how fast it responds.',
    cooldown: 3,
    async execute(ctx) {
      const sentAt = Number(ctx.msg.messageTimestamp ?? 0) * 1000;
      const latency = sentAt ? Math.max(0, Date.now() - sentAt) : 0;
      await ctx.reply(`🏓 ${bold('Pong!')}${latency ? `\n${quote(`${bold('Response:')} ~${latency} ms`)}` : ''}`);
    }
  },
  {
    name: 'uptime',
    aliases: ['runtime'],
    category: 'general',
    description: 'Show how long the bot has been running.',
    cooldown: 5,
    async execute(ctx) {
      await ctx.reply(`⏱️ ${field('Uptime', duration(process.uptime()))}`);
    }
  },
  {
    name: 'botinfo',
    aliases: ['about', 'botstatus', 'alive'],
    category: 'general',
    description: 'Show how the bot is set up right now.',
    cooldown: 10,
    async execute(ctx) {
      const s = ctx.settings;
      const flag = (on: boolean) => (on ? '✅' : '❌');
      const where = { all: 'Everywhere', groups: 'Groups only', private: 'Private chats only' }[s.commands.scope];
      const parts = [
        card('🤖', 'B-Bot is online', [
          `⏱️ ${field('Uptime', duration(process.uptime()))}`,
          `🔑 ${field('Mode', s.commands.mode === 'public' ? 'Public' : 'Private')}`,
          `📍 ${field('Works in', where)}`,
          `🏷️ ${field('Prefix', code(ctx.prefix))}`
        ])
      ];
      if (ctx.isOwner) {
        parts.push(
          card('⚙️', 'Features', [
            `${flag(s.antiDelete.enabled)} Anti-delete`,
            `${flag(s.viewOnce.enabled)} Anti view-once`,
            `${flag(s.status.autoView)} Auto status view`,
            `${flag(s.calls.reject)} Call rejection`,
            `${flag(s.ai.enabled)} AI assistant`,
            `${flag(s.autoReply.enabled)} Auto-replies (${s.autoReply.rules.filter(rule => rule.enabled).length})`,
            `${flag(s.autoReply.awayEnabled)} Away message`,
            `${flag(s.downloads.enabled)} Downloads`,
            `🚫 ${field('Blocked', `${s.access.blockedUsers.length} people, ${s.access.blockedChats.length} groups`)}`
          ])
        );
      }
      await ctx.reply(parts.join('\n\n'));
    }
  },
  {
    name: 'owner',
    aliases: ['creator'],
    category: 'general',
    description: "Get the bot owner's contact.",
    cooldown: 10,
    async execute(ctx) {
      const me = ctx.bot.me;
      if (!me) return;
      const number = userPart(me.jid);
      const name = me.name?.trim() || 'Bot owner';
      const vcard = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `TEL;type=CELL;waid=${number}:+${number}`, 'END:VCARD'].join('\n');
      await ctx.reply({ contacts: { displayName: name, contacts: [{ vcard }] } });
    }
  },
  {
    name: 'report',
    aliases: ['feedback'],
    category: 'general',
    description: 'Send a message to the bot owner.',
    usage: 'report <message>',
    cooldown: 60,
    async execute(ctx) {
      const target = ctx.bot.alertJid();
      if (!ctx.text.trim() || !target) {
        await ctx.reply(`${fail('Write your message after the command')}\n${quote(`${bold('Usage:')} ${code(`${ctx.prefix}report <message>`)}`)}`);
        return;
      }
      await ctx.bot.send(target, {
        text: [
          card('📨', 'Report', [`👤 ${field('From', `@${userPart(ctx.sender)}${ctx.senderName ? ` (${ctx.senderName})` : ''}`)}`, `💬 ${field('Chat', ctx.group?.subject ?? 'Private chat')}`]),
          '',
          quote(ctx.text.trim().slice(0, 2000))
        ].join('\n'),
        mentions: [ctx.sender]
      });
      await ctx.reply(`✅ ${bold('Sent to the owner.')}\n${note('Thanks for letting them know.')}`);
    }
  },
  {
    name: 'jid',
    aliases: ['id'],
    category: 'general',
    description: "Show this chat's WhatsApp ID (handy for the alert target setting).",
    async execute(ctx) {
      await ctx.reply(card('🆔', 'IDs', [field('Chat', code(ctx.jid)), field('You', code(ctx.sender))]));
    }
  }
];
