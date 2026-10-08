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
import { bold, command as commandText, fail, quote } from '../whatsapp/format.js';
import { adminCommands } from './builtin/admin.js';
import { aiCommands } from './builtin/ai.js';
import { discoverCommands } from './builtin/discover.js';
import { downloadCommands } from './builtin/download.js';
import { funCommands } from './builtin/fun.js';
import { generalCommands } from './builtin/general.js';
import { infoCommands } from './builtin/info.js';
import { languageCommands } from './builtin/language.js';
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
    // Grouped by category; within one, the order they are defined in (most useful first).
    .sort((a, b) => a.category.localeCompare(b.category));
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
    ...languageCommands,
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

/** Who sent this, and may they use commands here? */
async function accessOf(bot: BotSession, msg: WAMessage, jid: string) {
  const { mode, scope } = getSettings().commands;
  const me = bot.me;
  const senderIds = msg.key.fromMe
    ? [me?.jid, me?.lid].filter((id): id is string => Boolean(id))
    : senderIdsOf(msg);
  const isOwner = msg.key.fromMe === true || (await bot.isOwner(senderIds));
  const isGroup = Boolean(isJidGroup(jid));
  // Private mode and the chat scope silently ignore everyone but owners.
  const allowed = isOwner || !(mode === 'private' || (scope === 'groups' && !isGroup) || (scope === 'private' && isGroup));
  return { senderIds, isOwner, isGroup, allowed };
}

/** Number of slips between two words: a wrong, missing or extra letter, or two neighbours swapped. */
function editDistance(a: string, b: string): number {
  let before: number[] = [];
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) next[j] = Math.min(next[j], before[j - 2] + 1);
    }
    before = row;
    row = next;
  }
  return row[b.length];
}

/** The command someone most likely meant by a mistyped name. */
export function closestCommand(typed: string, includeOwnerOnly: boolean): string | undefined {
  const word = typed.toLowerCase();
  // Two-letter words are one slip away from half the short aliases; guessing there is noise.
  if (word.length < 3) return undefined;
  const { disabled } = getSettings().commands;
  const tolerance = word.length <= 5 ? 1 : 2;
  let best: { name: string; distance: number } | undefined;
  for (const [name, target] of [...[...commands.keys()].map(key => [key, key] as const), ...aliases]) {
    const command = commands.get(target);
    if (!command || name.length < 3 || disabled.includes(command.name) || (command.ownerOnly && !includeOwnerOnly)) continue;
    const distance = editDistance(word, name);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

/**
 * A message that is written like a command but did not run: an unknown or switched-off
 * name, or a sender who may not use commands here. It must not be answered by the AI
 * assistant or the away message as if it were conversation.
 * Suggests the nearest command when the name looks like a typo.
 * @returns true when the message is command-like, i.e. the pipeline should stop
 */
export async function handleUnknownCommand(bot: BotSession, msg: WAMessage): Promise<boolean> {
  const settings = getSettings();
  const { prefix } = settings.commands;
  const jid = msg.key.remoteJid;
  if (!settings.commands.enabled || !jid || bot.sentByBot(msg.key.id)) return false;

  const body = textOf(contentOf(msg.message)).trim();
  if (!body.startsWith(prefix)) return false;
  const invoked = body.slice(prefix.length).split(/\s+/)[0] ?? '';
  // "..." or ".5" is punctuation, not an attempt at a command.
  if (!/^[a-z][a-z0-9_-]{0,24}$/i.test(invoked)) return false;

  const { isOwner, allowed } = await accessOf(bot, msg, jid);
  if (!allowed || findCommand(invoked)) return true;
  const suggestion = closestCommand(invoked, isOwner);
  if (suggestion) {
    await bot.send(
      jid,
      { text: `❓ ${bold('Unknown command')}\n${quote(`Did you mean ${commandText(prefix, suggestion)}? Send ${commandText(prefix, 'menu')} to see everything.`)}` },
      { quoted: msg }
    );
  }
  return true;
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

  const { senderIds, isOwner, isGroup, allowed } = await accessOf(bot, msg, jid);
  if (!allowed) return false;

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
