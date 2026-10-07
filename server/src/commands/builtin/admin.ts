import type { ParticipantAction } from '@whiskeysockets/baileys';
import { prisma } from '../../db.js';
import {
  getGroupSetting,
  parseWhitelist,
  saveGroupSetting,
  type AntiLinkAction
} from '../../features/group-guard.js';
import { card, code, field, quote } from '../../whatsapp/format.js';
import { userPart } from '../../whatsapp/message-utils.js';
import type { Command, CommandContext } from '../types.js';

/** People a moderation command applies to: @mentions, else the author of the quoted message. */
function targetsOf(ctx: CommandContext): string[] {
  if (ctx.mentions.length) return ctx.mentions;
  return ctx.quoted ? [ctx.quoted.sender] : [];
}

function memberCommand(name: string, action: ParticipantAction, description: string, done: string): Command {
  return {
    name,
    category: 'admin',
    description,
    usage: `${name} @user`,
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      const targets = targetsOf(ctx);
      if (targets.length === 0) {
        await ctx.reply(`Mention someone or reply to their message: ${ctx.prefix}${name} @user`);
        return;
      }
      await ctx.sock.groupParticipantsUpdate(ctx.jid, targets, action);
      ctx.bot.invalidateGroup(ctx.jid);
      await ctx.send({ text: `${done} ${targets.map(jid => `@${userPart(jid)}`).join(', ')}`, mentions: targets });
    }
  };
}

function messageToggle(
  name: string,
  label: string,
  enabledField: 'welcomeEnabled' | 'farewellEnabled',
  templateField: 'welcomeTemplate' | 'farewellTemplate'
): Command {
  return {
    name,
    category: 'admin',
    description: `Turn the ${label} message on or off, or set its text.`,
    usage: `${name} on|off|<text>`,
    adminOnly: true,
    async execute(ctx) {
      const first = ctx.args[0]?.toLowerCase();
      const base = { name: ctx.group?.subject };
      if (first === 'on' || first === 'off') {
        await saveGroupSetting(ctx.bot.id, ctx.jid, { ...base, [enabledField]: first === 'on' });
        await ctx.reply(`The ${label} message is now *${first}*.`);
      } else if (ctx.text) {
        await saveGroupSetting(ctx.bot.id, ctx.jid, { ...base, [enabledField]: true, [templateField]: ctx.text });
        await ctx.reply(`The ${label} message was updated and turned on.`);
      } else {
        const setting = await getGroupSetting(ctx.bot.id, ctx.jid);
        await ctx.reply(
          `The ${label} message is *${setting?.[enabledField] ? 'on' : 'off'}*.\n` +
            `${ctx.prefix}${name} on|off, or ${ctx.prefix}${name} <text> to change it.\n` +
            'Placeholders: {user} {group} {desc} {count}'
        );
      }
    }
  };
}

export const adminCommands: Command[] = [
  memberCommand('kick', 'remove', 'Remove a member from the group.', '👋 Removed'),
  memberCommand('promote', 'promote', 'Make a member a group admin.', '⬆️ Promoted'),
  memberCommand('demote', 'demote', 'Remove admin rights from a member.', '⬇️ Demoted'),
  {
    name: 'tagall',
    aliases: ['everyone'],
    category: 'admin',
    description: 'Mention every member of the group.',
    usage: 'tagall [message]',
    adminOnly: true,
    cooldown: 60,
    async execute(ctx) {
      const members = ctx.group?.participants.map(p => p.id) ?? [];
      const header = ctx.text || '📢 Attention everyone';
      await ctx.send({ text: `${header}\n\n${members.map(jid => `@${userPart(jid)}`).join(' ')}`, mentions: members });
    }
  },
  {
    name: 'antilink',
    category: 'admin',
    description: 'Configure link filtering for this group.',
    usage: 'antilink on|off|<action>',
    adminOnly: true,
    async execute(ctx) {
      const option = ctx.args[0]?.toLowerCase();
      const base = { name: ctx.group?.subject };
      if (option === 'on' || option === 'off') {
        await saveGroupSetting(ctx.bot.id, ctx.jid, { ...base, antiLink: option === 'on' });
        const note = option === 'on' && !ctx.isBotAdmin ? '\n⚠️ Make me an admin so I can delete messages.' : '';
        await ctx.reply(`🔗 Anti-link is now *${option}*.${note}`);
      } else if (option === 'delete' || option === 'warn' || option === 'kick') {
        await saveGroupSetting(ctx.bot.id, ctx.jid, { ...base, antiLink: true, antiLinkAction: option as AntiLinkAction });
        await ctx.reply(`🔗 Anti-link is on, action: *${option}*.`);
      } else if (option === 'whatsapp' || option === 'all') {
        await saveGroupSetting(ctx.bot.id, ctx.jid, { ...base, antiLinkMode: option });
        await ctx.reply(`🔗 Anti-link now blocks *${option === 'all' ? 'every link' : 'WhatsApp invite links only'}*.`);
      } else {
        const setting = await getGroupSetting(ctx.bot.id, ctx.jid);
        const whitelist = parseWhitelist(setting);
        await ctx.reply(
          [
            `🔗 Anti-link: *${setting?.antiLink ? 'on' : 'off'}*`,
            `Blocks: ${setting?.antiLinkMode === 'all' ? 'every link' : 'WhatsApp invite links'}`,
            `Action: ${setting?.antiLinkAction ?? 'delete'} (warn limit ${setting?.warnLimit ?? 3})`,
            `Whitelist: ${whitelist.length ? whitelist.join(', ') : 'none'}`,
            '',
            `${ctx.prefix}antilink on|off|delete|warn|kick|whatsapp|all`
          ].join('\n')
        );
      }
    }
  },
  messageToggle('welcome', 'welcome', 'welcomeEnabled', 'welcomeTemplate'),
  messageToggle('goodbye', 'farewell', 'farewellEnabled', 'farewellTemplate'),
  {
    name: 'resetwarn',
    category: 'admin',
    description: "Clear a member's link warnings.",
    usage: 'resetwarn @user',
    adminOnly: true,
    async execute(ctx) {
      const targets = targetsOf(ctx);
      if (targets.length === 0) {
        await ctx.reply(`Mention someone: ${ctx.prefix}resetwarn @user`);
        return;
      }
      await prisma.groupWarning.deleteMany({
        where: { sessionId: ctx.bot.id, groupJid: ctx.jid, userJid: { in: targets } }
      });
      await ctx.reply('✅ Warnings cleared.');
    }
  },
  {
    name: 'mute',
    category: 'admin',
    description: 'Only admins can send messages.',
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      await ctx.sock.groupSettingUpdate(ctx.jid, 'announcement');
      await ctx.reply('🔇 Group muted: only admins can send messages.');
    }
  },
  {
    name: 'unmute',
    category: 'admin',
    description: 'Everyone can send messages again.',
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      await ctx.sock.groupSettingUpdate(ctx.jid, 'not_announcement');
      await ctx.reply('🔊 Group unmuted: everyone can send messages.');
    }
  },
  {
    name: 'add',
    category: 'admin',
    description: 'Add someone to the group by phone number.',
    usage: 'add <number>',
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      const numbers = ctx.text.split(/[\s,]+/).map(part => part.replace(/\D/g, '')).filter(part => /^\d{7,15}$/.test(part));
      if (numbers.length === 0) {
        await ctx.reply(`Give me a number with country code: ${ctx.prefix}add 15551234567`);
        return;
      }
      const result = await ctx.sock.groupParticipantsUpdate(ctx.jid, numbers.map(number => `${number}@s.whatsapp.net`), 'add');
      ctx.bot.invalidateGroup(ctx.jid);
      const failed = result.filter(item => item.status !== '200').map(item => `+${userPart(item.jid ?? '')}`);
      await ctx.reply(
        failed.length
          ? `Could not add ${failed.join(', ')}. Their privacy settings may only allow an invite link (${ctx.prefix}link).`
          : `✅ Added ${numbers.map(number => `+${number}`).join(', ')}.`
      );
    }
  },
  {
    name: 'hidetag',
    aliases: ['announce'],
    category: 'admin',
    description: 'Send a message that notifies everyone without listing their names.',
    usage: 'hidetag <message>',
    adminOnly: true,
    cooldown: 30,
    async execute(ctx) {
      const text = ctx.text || ctx.quoted?.text;
      if (!text) {
        await ctx.reply(`Write the announcement: ${ctx.prefix}hidetag Meeting at 5pm`);
        return;
      }
      await ctx.send({ text, mentions: ctx.group?.participants.map(p => p.id) ?? [] });
    }
  },
  {
    name: 'admins',
    category: 'admin',
    description: 'Mention the group admins.',
    groupOnly: true,
    cooldown: 60,
    async execute(ctx) {
      const admins = ctx.group?.participants.filter(p => p.admin).map(p => p.id) ?? [];
      const note = ctx.text ? `\n\n${ctx.text}` : '';
      await ctx.send({ text: `🛡️ *Admins*\n${admins.map(jid => `@${userPart(jid)}`).join('\n')}${note}`, mentions: admins });
    }
  },
  {
    name: 'link',
    aliases: ['invite'],
    category: 'admin',
    description: "Get the group's invite link.",
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      const code = await ctx.sock.groupInviteCode(ctx.jid);
      await ctx.reply(code ? `🔗 https://chat.whatsapp.com/${code}` : 'I could not get the invite link.');
    }
  },
  {
    name: 'revoke',
    aliases: ['resetlink'],
    category: 'admin',
    description: 'Reset the invite link so the old one stops working.',
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      const code = await ctx.sock.groupRevokeInvite(ctx.jid);
      await ctx.reply(code ? `🔗 The old link no longer works. New link:\nhttps://chat.whatsapp.com/${code}` : 'I could not reset the link.');
    }
  },
  {
    name: 'setname',
    category: 'admin',
    description: 'Change the group name.',
    usage: 'setname <new name>',
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      if (!ctx.text || ctx.text.length > 100) {
        await ctx.reply(`Give me a name of up to 100 characters: ${ctx.prefix}setname Weekend plans`);
        return;
      }
      await ctx.sock.groupUpdateSubject(ctx.jid, ctx.text);
      ctx.bot.invalidateGroup(ctx.jid);
      await ctx.react('✅');
    }
  },
  {
    name: 'setdesc',
    category: 'admin',
    description: 'Change the group description.',
    usage: 'setdesc <text>',
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      const text = ctx.text || ctx.quoted?.text;
      if (!text) {
        await ctx.reply(`Write the description: ${ctx.prefix}setdesc Be kind, no spam.`);
        return;
      }
      await ctx.sock.groupUpdateDescription(ctx.jid, text);
      ctx.bot.invalidateGroup(ctx.jid);
      await ctx.react('✅');
    }
  },
  {
    name: 'lock',
    category: 'admin',
    description: 'Only admins can change the group name, picture and description.',
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      await ctx.sock.groupSettingUpdate(ctx.jid, 'locked');
      await ctx.reply('🔒 Only admins can edit the group info now.');
    }
  },
  {
    name: 'unlock',
    category: 'admin',
    description: 'Everyone can change the group name, picture and description.',
    adminOnly: true,
    botAdmin: true,
    async execute(ctx) {
      await ctx.sock.groupSettingUpdate(ctx.jid, 'unlocked');
      await ctx.reply('🔓 Everyone can edit the group info now.');
    }
  },
  {
    name: 'del',
    aliases: ['delete'],
    category: 'admin',
    description: "Delete the message you reply to (my own, or anyone's when I am an admin).",
    async execute(ctx) {
      if (!ctx.quoted) {
        await ctx.reply('Reply to the message you want deleted.');
        return;
      }
      const key = ctx.quoted.message.key;
      const mine = key.participant ? await ctx.bot.isSelf(key.participant) : !ctx.isGroup && ctx.bot.sentByBot(key.id);
      if (!ctx.isOwner && !ctx.isAdmin) {
        await ctx.reply('🛡️ Only owners and group admins can delete messages.');
        return;
      }
      if (!mine && !(ctx.isGroup && ctx.isBotAdmin)) {
        await ctx.reply("🛡️ I can only delete other people's messages in groups where I am an admin.");
        return;
      }
      await ctx.sock.sendMessage(ctx.jid, { delete: { ...key, fromMe: Boolean(mine) } });
    }
  },
  {
    name: 'warn',
    category: 'admin',
    description: "Give a member a warning; they are removed when they reach the group's limit.",
    usage: 'warn @user [reason]',
    adminOnly: true,
    async execute(ctx) {
      const [target] = targetsOf(ctx);
      if (!target) {
        await ctx.reply(`Mention someone or reply to their message: ${ctx.prefix}warn @user spamming`);
        return;
      }
      if ((ctx.group && ctx.bot.isGroupAdmin(ctx.group, [target])) || (await ctx.bot.isSelf(target))) {
        await ctx.reply('Admins cannot be warned.');
        return;
      }
      const limit = (await getGroupSetting(ctx.bot.id, ctx.jid))?.warnLimit ?? 3;
      const where = { sessionId_groupJid_userJid: { sessionId: ctx.bot.id, groupJid: ctx.jid, userJid: target } };
      const { count } = await prisma.groupWarning.upsert({
        where,
        create: { ...where.sessionId_groupJid_userJid, count: 1 },
        update: { count: { increment: 1 } }
      });
      const reason = ctx.text.replace(/@\d+/g, '').trim();
      const tag = `@${userPart(target)}`;
      if (count >= limit && ctx.isBotAdmin) {
        await prisma.groupWarning.delete({ where });
        await ctx.sock.groupParticipantsUpdate(ctx.jid, [target], 'remove');
        ctx.bot.invalidateGroup(ctx.jid);
        await ctx.send({ text: `🚫 ${tag} reached ${limit}/${limit} warnings and was removed.`, mentions: [target] });
      } else {
        await ctx.send({ text: `⚠️ ${tag} warning ${count}/${limit}${reason ? `\n*Reason:* ${reason}` : ''}`, mentions: [target] });
      }
    }
  },
  {
    name: 'warnings',
    aliases: ['warns'],
    category: 'admin',
    description: 'Show warnings in this group (for one member or everyone).',
    usage: 'warnings [@user]',
    groupOnly: true,
    async execute(ctx) {
      const [target] = targetsOf(ctx);
      const rows = await prisma.groupWarning.findMany({
        where: { sessionId: ctx.bot.id, groupJid: ctx.jid, ...(target ? { userJid: target } : {}) },
        orderBy: { count: 'desc' },
        take: 30
      });
      const limit = (await getGroupSetting(ctx.bot.id, ctx.jid))?.warnLimit ?? 3;
      if (rows.length === 0) {
        await ctx.reply(target ? 'They have no warnings.' : 'Nobody has warnings in this group.');
        return;
      }
      await ctx.send({
        text: `⚠️ *Warnings*\n${rows.map(row => `@${userPart(row.userJid)}: ${row.count}/${limit}`).join('\n')}`,
        mentions: rows.map(row => row.userJid)
      });
    }
  },
  {
    name: 'leave',
    category: 'admin',
    description: 'Make the bot leave this group.',
    ownerOnly: true,
    groupOnly: true,
    async execute(ctx) {
      await ctx.send('👋 Goodbye!');
      await ctx.sock.groupLeave(ctx.jid);
    }
  },
  {
    name: 'groupinfo',
    category: 'admin',
    description: 'Show details about this group.',
    groupOnly: true,
    cooldown: 10,
    async execute(ctx) {
      const group = ctx.group;
      if (!group) return;
      const admins = group.participants.filter(p => p.admin).length;
      await ctx.reply(
        [
          card('👥', group.subject, [
            `👤 ${field('Members', group.participants.length)}`,
            `🛡️ ${field('Admins', admins)}`,
            `📅 ${field('Created', group.creation ? new Date(group.creation * 1000).toDateString() : 'unknown')}`,
            `🆔 ${code(group.id)}`
          ]),
          group.desc ? `\n${quote(group.desc)}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      );
    }
  }
];
