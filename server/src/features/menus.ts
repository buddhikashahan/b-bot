import type { CustomMenu as CustomMenuRow } from '@prisma/client';
import { isJidGroup, type WAMessage } from '@whiskeysockets/baileys';
import { z } from 'zod';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';
import { bold, card, italic, quote } from '../whatsapp/format.js';
import { contentOf, contextInfoOf, textOf } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { recordActivity } from './activity.js';

// Reply-by-number menus.
//
// Whenever the bot sends a numbered list, the message id and what each number
// means are stored in the MenuPrompt table. When someone replies to that
// message with "2", the stored option is looked up and carried out. Because
// the mapping lives in the database, menus keep working across restarts.

const log = scoped('menus');

const PROMPT_TTL_MS = 24 * 60 * 60 * 1000;
/** In a private chat a bare number (no quote) answers the latest menu if it is this recent. */
const BARE_REPLY_WINDOW_MS = 10 * 60 * 1000;
const MAX_OPTIONS = 30;

export type MenuAction =
  /** Run a bot command; `text` is the command without its prefix, e.g. "menu downloads". */
  | { type: 'command'; text: string }
  /** Send a fixed reply. */
  | { type: 'text'; text: string }
  /** Open a menu designed in the dashboard. */
  | { type: 'menu'; menuId: string };

export interface MenuOption {
  label: string;
  action: MenuAction;
}

export const MENU_HINT = quote(italic('Reply to this message with a number'));

/** "*1.* First\n*2.* Second" */
export function numberedOptions(options: MenuOption[]): string {
  return options.map((option, index) => `${bold(`${index + 1}.`)} ${option.label}`).join('\n');
}

/** Remember what the numbers on a sent message mean. */
export async function registerPrompt(sessionId: string, chatJid: string, messageId: string, options: MenuOption[]): Promise<void> {
  const data = { chatJid, options: JSON.stringify(options.slice(0, MAX_OPTIONS)), expiresAt: new Date(Date.now() + PROMPT_TTL_MS), createdAt: new Date() };
  await prisma.menuPrompt.upsert({
    where: { sessionId_messageId: { sessionId, messageId } },
    create: { sessionId, messageId, ...data },
    update: data
  });
}

/**
 * Send a numbered menu and register it.
 * @param header everything above the options (usually a card)
 */
export async function sendMenu(
  bot: BotSession,
  jid: string,
  menu: { header: string; options: MenuOption[]; footer?: string; quoted?: WAMessage; mentions?: string[] }
): Promise<void> {
  const options = menu.options.slice(0, MAX_OPTIONS);
  const text = [menu.header, '', numberedOptions(options), '', menu.footer ?? MENU_HINT].join('\n');
  const sent = await bot.send(jid, { text, mentions: menu.mentions }, menu.quoted ? { quoted: menu.quoted } : undefined);
  if (sent?.key.id) await registerPrompt(bot.id, jid, sent.key.id, options);
}

export type MenuReply = { option: MenuOption } | { outOfRange: number };

/**
 * Is this message a number answering one of our menus?
 * Matches a reply quoting the menu message, or in private chats a bare number
 * sent shortly after a menu.
 */
export async function resolveMenuReply(bot: BotSession, msg: WAMessage): Promise<MenuReply | undefined> {
  const jid = msg.key.remoteJid;
  const content = contentOf(msg.message);
  const text = textOf(content).trim();
  if (!jid || !/^\d{1,2}$/.test(text)) return undefined;

  const quotedId = contextInfoOf(content)?.stanzaId;
  let prompt;
  if (quotedId) {
    prompt = await prisma.menuPrompt.findUnique({ where: { sessionId_messageId: { sessionId: bot.id, messageId: quotedId } } });
  } else if (!isJidGroup(jid) && !msg.key.fromMe) {
    // The owner typing "1" to a friend must never be read as a menu choice, hence !fromMe.
    prompt = await prisma.menuPrompt.findFirst({
      where: { sessionId: bot.id, chatJid: jid, createdAt: { gte: new Date(Date.now() - BARE_REPLY_WINDOW_MS) } },
      orderBy: { createdAt: 'desc' }
    });
  }
  if (!prompt || prompt.expiresAt < new Date()) return undefined;

  let options: MenuOption[];
  try {
    options = JSON.parse(prompt.options) as MenuOption[];
  } catch {
    return undefined;
  }
  const option = options[Number(text) - 1];
  // Only complain about a wrong number when the menu was explicitly quoted.
  if (!option) return quotedId ? { outOfRange: options.length } : undefined;
  return { option };
}

export async function purgeExpiredPrompts(): Promise<void> {
  await prisma.menuPrompt.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

// --- menus designed in the dashboard ----------------------------------------------------------

const OptionSchema = z.object({
  label: z.string().trim().min(1, 'Every option needs a label.').max(80),
  type: z.enum(['text', 'menu', 'command']),
  /** The reply text, the id of another menu, or a command (with or without its prefix). */
  value: z.string().trim().min(1, 'Every option needs something to do.').max(3000)
});

export const CustomMenuSchema = z.object({
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  /** What someone types to get this menu. */
  trigger: z.string().trim().min(1).max(100),
  match: z.enum(['exact', 'contains', 'starts']).default('exact'),
  scope: z.enum(['all', 'private', 'groups']).default('private'),
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().max(2000).default(''),
  options: z.array(OptionSchema).min(1, 'Add at least one option.').max(20)
});
export type CustomMenuInput = z.infer<typeof CustomMenuSchema>;
export type CustomMenuOption = z.infer<typeof OptionSchema>;

export interface CustomMenu extends CustomMenuInput {
  id: string;
}

function fromRow(row: CustomMenuRow): CustomMenu {
  let options: CustomMenuOption[] = [];
  try {
    options = JSON.parse(row.options) as CustomMenuOption[];
  } catch {
    log.warn(`menu "${row.name}" has unreadable options`);
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    match: row.match as CustomMenu['match'],
    scope: row.scope as CustomMenu['scope'],
    title: row.title,
    body: row.body ?? '',
    options
  };
}

/** Menus are read on every incoming message, so keep them in memory. */
let cache: Map<string, CustomMenu[]> | undefined;

async function menusFor(sessionId: string): Promise<CustomMenu[]> {
  if (!cache) {
    cache = new Map();
    for (const row of await prisma.customMenu.findMany({ orderBy: { createdAt: 'asc' } })) {
      const list = cache.get(row.sessionId) ?? [];
      list.push(fromRow(row));
      cache.set(row.sessionId, list);
    }
  }
  return cache.get(sessionId) ?? [];
}

export const listCustomMenus = menusFor;

function toData(input: CustomMenuInput) {
  const { options, ...rest } = input;
  return { ...rest, body: rest.body || null, options: JSON.stringify(options) };
}

export async function createCustomMenu(sessionId: string, input: CustomMenuInput): Promise<CustomMenu> {
  const row = await prisma.customMenu.create({ data: { sessionId, ...toData(input) } });
  cache = undefined;
  return fromRow(row);
}

export async function updateCustomMenu(id: string, input: CustomMenuInput): Promise<CustomMenu> {
  const row = await prisma.customMenu.update({ where: { id }, data: toData(input) });
  cache = undefined;
  return fromRow(row);
}

export async function deleteCustomMenu(id: string): Promise<void> {
  await prisma.customMenu.deleteMany({ where: { id } });
  cache = undefined;
}

function matches(menu: CustomMenu, text: string): boolean {
  const said = text.trim().toLowerCase();
  const trigger = menu.trigger.trim().toLowerCase();
  if (menu.match === 'exact') return said === trigger;
  if (menu.match === 'starts') return said.startsWith(trigger);
  return said.includes(trigger);
}

const fill = (text: string, msg: WAMessage) => text.replaceAll('{name}', msg.pushName?.trim() || 'there');

/** Send one dashboard-designed menu. */
export async function sendCustomMenu(bot: BotSession, msg: WAMessage, menu: CustomMenu): Promise<void> {
  const jid = msg.key.remoteJid!;
  const options: MenuOption[] = menu.options.map(option => ({
    label: option.label,
    action:
      option.type === 'menu'
        ? { type: 'menu', menuId: option.value }
        : option.type === 'command'
          ? // People type commands with whatever the prefix is today; store them without it.
            { type: 'command', text: option.value.replace(/^[^\w\s]{1,3}(?=\w)/, '') }
          : { type: 'text', text: option.value }
  }));
  const header = card('📋', menu.title, menu.body ? [fill(menu.body, msg)] : []);
  await sendMenu(bot, jid, { header, options, quoted: isJidGroup(jid) ? msg : undefined });
}

export async function sendCustomMenuById(bot: BotSession, msg: WAMessage, menuId: string): Promise<boolean> {
  const menu = (await menusFor(bot.id)).find(item => item.id === menuId);
  if (!menu) return false;
  await sendCustomMenu(bot, msg, menu);
  return true;
}

const lastSent = new Map<string, number>();

/**
 * Send the dashboard menu whose trigger matches this message, if any.
 * @returns true when a menu was sent
 */
export async function handleMenuTrigger(bot: BotSession, msg: WAMessage): Promise<boolean> {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe) return false;
  const text = textOf(contentOf(msg.message));
  if (!text) return false;
  const isGroup = Boolean(isJidGroup(jid));
  const menu = (await menusFor(bot.id)).find(
    item => item.enabled && (item.scope === 'all' || (item.scope === 'groups') === isGroup) && matches(item, text)
  );
  if (!menu) return false;
  // Same guard as auto-replies: never answer the same chat more than once every few seconds.
  const now = Date.now();
  if (now - (lastSent.get(jid) ?? 0) < 3000) return false;
  lastSent.set(jid, now);
  if (lastSent.size > 5000) for (const [chat, time] of lastSent) if (now - time > 60_000) lastSent.delete(chat);

  await sendCustomMenu(bot, msg, menu);
  recordActivity(bot.id, 'menu', `Sent the "${menu.name}" menu to ${msg.pushName?.trim() || 'a contact'}`, { chat: jid });
  return true;
}
