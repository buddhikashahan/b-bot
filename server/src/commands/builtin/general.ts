import { config } from '../../config.js';
import { DEVELOPER } from '../../developer.js';
import { coverImage } from '../../features/branding.js';
import { sendLinkCard, sendMenu, type LinkButton, type MenuOption } from '../../features/menus.js';
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
  { key: 'adult', icon: '🔞', title: '18+', words: ['adult', '18', '18+', 'nsfw'] },
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
  // The 18+ commands are listed only where they can run: switched on, and never in a group.
  const adult = ctx.settings.adult.enabled && !ctx.isGroup;
  return listCommands().filter(item => !disabled.has(item.name) && (!item.ownerOnly || ctx.isOwner) && (item.category !== 'adult' || adult));
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
  return card('🤖', ctx.settings.branding.botName, [
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
        options: [
          ...sections.map(
            (section): MenuOption => ({
              label: `${section.icon} ${section.title} ${italic(`(${section.items.length})`)}`,
              action: { type: 'command', text: `menu ${section.words[0]}` }
            })
          ),
          // With tappable menus this one is also a button beside the category list.
          { label: `📜 All commands ${italic('on one page')}`, button: '📜 All commands', shortcut: true, action: { type: 'command', text: 'menu all' } }
        ],
        footer: quote(italic('Reply to this message with a number to open a category')),
        quoted: ctx.msg,
        image: await coverImage()
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
        card('🤖', `${s.branding.botName} is online`, [
          `🧬 ${field('Version', config.version)}`,
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
      const caption = parts.join('\n\n');
      const image = await coverImage();
      await ctx.reply(image ? { image, caption } : caption);
    }
  },
  {
    name: 'owner',
    category: 'general',
    description: "Get the contact of the bot's owner.",
    cooldown: 10,
    async execute(ctx) {
      // The owners named in the dashboard; without any, the linked account is the owner.
      const me = ctx.bot.me;
      const numbers = ctx.settings.general.ownerNumbers.length ? ctx.settings.general.ownerNumbers : me ? [userPart(me.jid)] : [];
      if (numbers.length === 0) return;
      const own = me ? userPart(me.jid) : '';
      const botName = ctx.settings.branding.botName;
      const contacts = numbers.map((number, index) => {
        const name = number === own && me?.name?.trim() ? me.name.trim() : numbers.length > 1 ? `${botName} owner ${index + 1}` : `${botName} owner`;
        return { name, vcard: ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `ORG:${botName};`, `TEL;type=CELL;type=VOICE;waid=${number}:+${number}`, 'END:VCARD'].join('\n') };
      });
      await ctx.reply({ contacts: { displayName: contacts.length > 1 ? `${contacts.length} owners of ${botName}` : contacts[0].name, contacts: contacts.map(({ vcard }) => ({ vcard })) } });
    }
  },
  {
    name: 'developer',
    aliases: ['dev', 'creator', 'author', 'credits'],
    category: 'general',
    description: 'Who made this bot, and how to reach them.',
    cooldown: 10,
    async execute(ctx) {
      const { botName } = ctx.settings.branding;
      const { name, number: developerNumber, website, github } = DEVELOPER;
      const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
      const caption = [
        card('👨‍💻', 'Developer', [
          `🧑 ${field('Name', name)}`,
          `🤖 ${field('Bot', `${botName} v${config.version}`)}`,
          `📞 ${field('WhatsApp', `+${developerNumber}`)}`,
          `🌐 ${field('Website', bare(website))}`,
          `💻 ${field('GitHub', bare(github))}`,
          `⚙️ ${field('Built with', 'Node.js, TypeScript, Baileys')}`
        ]),
        '',
        note('Their contact card is below. Say hi!')
      ].join('\n');
      const image = await coverImage();
      const links: LinkButton[] = [
        { label: '📞 Contact', url: `https://wa.me/${developerNumber}` },
        { label: '🌐 Portfolio', url: website },
        { label: '💻 GitHub', url: github }
      ];
      // Link buttons when tappable menus are on, the plain card otherwise.
      if (!(await sendLinkCard(ctx.bot, ctx.jid, { text: caption, links, image, quoted: ctx.msg }))) {
        await ctx.reply(image ? { image, caption } : caption);
      }
      const vcard = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `ORG:${botName} developer;`, `TEL;type=CELL;type=VOICE;waid=${developerNumber}:+${developerNumber}`, `URL:${website}`, 'END:VCARD'].join('\n');
      await ctx.send({ contacts: { displayName: name, contacts: [{ vcard }] } });
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
