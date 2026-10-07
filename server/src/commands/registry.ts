import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isJidGroup, jidNormalizedUser, type AnyMessageContent, type WAMessage } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import { recordActivity } from '../features/activity.js';
import { contentOf, contextInfoOf, displayNumber, preferPn, senderIdsOf, textOf } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { bold, fail, quote } from '../whatsapp/format.js';
import { adminCommands } from './builtin/admin.js';
import { aiCommands } from './builtin/ai.js';
import { discoverCommands } from './builtin/discover.js';
import { downloadCommands } from './builtin/download.js';
import { funCommands } from './builtin/fun.js';
import { generalCommands } from './builtin/general.js';
import { infoCommands } from './builtin/info.js';
import { mediaCommands } from './builtin/media.js';
import { utilityCommands } from './builtin/utility.js';
import type { Command, CommandContext, QuotedMessage } from './types.js';

const log = scoped('commands');

const commands = new Map<string, Command>();
const aliases = new Map<string, string>();
const sources = new Map<string, 'builtin' | 'plugin'>();
const cooldowns = new Map<string, number>();

function isCommand(value: unknown): value is Command {
  const candidate = value as Command;
  return Boolean(candidate && typeof candidate.name === 'string' && typeof candidate.execute === 'function');
}

export function registerCommand(command: Command, source: 'builtin' | 'plugin' = 'plugin'): void {
  const name = command.name.toLowerCase();
  if (commands.has(name)) log.warn(`command "${name}" from a ${source} replaces an existing one`);
  commands.set(name, { ...command, name });
  sources.set(name, source);
  for (const alias of command.aliases ?? []) aliases.set(alias.toLowerCase(), name);
}

export function findCommand(name: string): Command | undefined {
  const key = name.toLowerCase();
  return commands.get(key) ?? commands.get(aliases.get(key) ?? '');
}

export function listCommands(): (Omit<Command, 'execute'> & { source: 'builtin' | 'plugin' })[] {
  return [...commands.values()]
    .map(({ execute: _execute, ...meta }) => ({ ...meta, source: sources.get(meta.name) ?? 'plugin' }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/**
 * Register the built-in commands, then every plugin in data/plugins. A plugin is
 * an ES module (.js / .mjs) whose default export is a Command or an array of them.
 */
export async function loadCommands(): Promise<void> {
  commands.clear();
  aliases.clear();
  sources.clear();
  const builtin = [
    ...generalCommands,
    ...aiCommands,
    ...downloadCommands,
    ...infoCommands,
    ...discoverCommands,
    ...mediaCommands,
    ...utilityCommands,
    ...adminCommands,
    ...funCommands
  ];
  for (const command of builtin) {
    registerCommand(command, 'builtin');
  }

  const files = (await readdir(config.paths.plugins).catch(() => [] as string[])).filter(file => /\.m?js$/.test(file));
  for (const file of files) {
    try {
      // Cache-bust so "reload plugins" picks up edits without a restart.
      const url = `${pathToFileURL(path.join(config.paths.plugins, file)).href}?v=${Date.now()}`;
      const exported = (await import(url)).default;
      const found = (Array.isArray(exported) ? exported : [exported]).filter(isCommand);
      if (found.length === 0) {
        log.warn(`plugin ${file} has no default-exported command`);
        continue;
      }
      for (const command of found) registerCommand(command, 'plugin');
      log.info(`loaded plugin ${file} (${found.map(c => c.name).join(', ')})`);
    } catch (err) {
      log.error({ err }, `failed to load plugin ${file}`);
    }
  }
  log.info(`${commands.size} commands ready`);
}

function quotedOf(msg: WAMessage, jid: string): QuotedMessage | undefined {
  const context = contextInfoOf(contentOf(msg.message));
  if (!context?.quotedMessage || !context.stanzaId) return undefined;
  const content = contentOf(context.quotedMessage);
  if (!content) return undefined;
  const sender = context.participant ? jidNormalizedUser(context.participant) : jid;
  return {
    message: {
      key: { remoteJid: jid, id: context.stanzaId, participant: context.participant ?? undefined, fromMe: false },
      message: context.quotedMessage
    },
    content,
    sender,
    text: textOf(content)
  };
}

/**
 * Parse and run a command message.
 * @param chosen command text (without prefix) picked from a numbered menu; runs as if the sender had typed it
 * @returns true when the message was a command (whether or not it succeeded)
 */
export async function handleCommand(bot: BotSession, msg: WAMessage, chosen?: string): Promise<boolean> {
  const settings = getSettings();
  const { prefix } = settings.commands;
  const jid = msg.key.remoteJid;
  if (!settings.commands.enabled || !jid || !bot.sock || bot.sentByBot(msg.key.id)) return false;

  const content = contentOf(msg.message);
  const body = chosen !== undefined ? `${prefix}${chosen}` : textOf(content).trim();
  if (!body.startsWith(prefix) || body.length === prefix.length) return false;

  const [invoked = '', ...args] = body.slice(prefix.length).trim().split(/\s+/);
  const command = findCommand(invoked);
  if (!command || settings.commands.disabled.includes(command.name)) return false;

  const me = bot.me;
  const senderIds = msg.key.fromMe
    ? [me?.jid, me?.lid].filter((id): id is string => Boolean(id))
    : senderIdsOf(msg);
  const isOwner = msg.key.fromMe === true || (await bot.isOwner(senderIds));
  const isGroup = Boolean(isJidGroup(jid));
  // Private mode and the chat scope silently ignore everyone but owners.
  if (!isOwner) {
    const { mode, scope } = settings.commands;
    if (mode === 'private' || (scope === 'groups' && !isGroup) || (scope === 'private' && isGroup)) return false;
  }

  const group = isGroup ? await bot.groupMeta(jid) : undefined;
  const isAdmin = group ? bot.isGroupAdmin(group, senderIds) : false;
  const isBotAdmin = group ? bot.botIsAdmin(group) : false;
  const sock = bot.sock;

  const toContent = (value: string | AnyMessageContent): AnyMessageContent =>
    typeof value === 'string' ? { text: value } : value;
  const ctx: CommandContext = {
    bot,
    sock,
    msg,
    jid,
    sender: preferPn(senderIds) ?? jid,
    senderIds,
    senderName: msg.pushName ?? '',
    isGroup,
    isOwner,
    isAdmin,
    isBotAdmin,
    group,
    prefix,
    command: invoked.toLowerCase(),
    args,
    text: body.slice(prefix.length).trim().slice(invoked.length).trim(),
    mentions: (contextInfoOf(content)?.mentionedJid ?? []).map(id => jidNormalizedUser(id)),
    // A menu choice quotes the menu itself, which is not something for the command to act on.
    quoted: chosen !== undefined ? undefined : quotedOf(msg, jid),
    settings,
    log: scoped(`cmd:${command.name}`),
    reply: value => bot.send(jid, toContent(value), { quoted: msg }),
    send: value => bot.send(jid, toContent(value)),
    react: async emoji => {
      await bot.send(jid, { react: { text: emoji, key: msg.key } });
    }
  };

  const needsGroup = command.groupOnly || command.adminOnly || command.botAdmin;
  if (command.ownerOnly && !isOwner) {
    await ctx.reply(`🔒 ${bold('Owner command')}\n${quote('This command is for the bot owner only.')}`);
    return true;
  }
  if (needsGroup && !isGroup) {
    await ctx.reply(`👥 ${bold('Group command')}\n${quote('This command only works in groups.')}`);
    return true;
  }
  if (command.adminOnly && !isAdmin && !isOwner) {
    await ctx.reply(`🛡️ ${bold('Admin command')}\n${quote('Only group admins can use this command.')}`);
    return true;
  }
  if (command.botAdmin && !isBotAdmin) {
    await ctx.reply(`🛡️ ${bold('I need admin rights')}\n${quote('Make me a group admin and try again.')}`);
    return true;
  }

  // Picking a number from a menu is the next step of something already started,
  // so it neither waits for a cooldown nor starts one.
  if (command.cooldown && !isOwner && chosen === undefined) {
    const key = `${command.name}:${ctx.sender}`;
    const readyAt = cooldowns.get(key) ?? 0;
    if (readyAt > Date.now()) {
      await ctx.reply(`⏳ ${bold('Slow down')}\n${quote(`Try again in ${Math.ceil((readyAt - Date.now()) / 1000)}s.`)}`);
      return true;
    }
    cooldowns.set(key, Date.now() + command.cooldown * 1000);
    if (cooldowns.size > 5000) {
      for (const [entry, time] of cooldowns) if (time < Date.now()) cooldowns.delete(entry);
    }
  }

  try {
    await command.execute(ctx);
    recordActivity(bot.id, 'command', `${prefix}${command.name} used by ${msg.pushName?.trim() || displayNumber(ctx.sender)}`, {
      detail: ctx.text.slice(0, 200) || undefined,
      chat: jid
    });
  } catch (err) {
    ctx.log.error({ err }, 'command failed');
    await ctx.reply(fail('That did not work', err instanceof Error ? err.message : 'Something went wrong.')).catch(() => {});
  }
  return true;
}
