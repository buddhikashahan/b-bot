import type { CustomMenu as CustomMenuRow } from '@prisma/client';
import { generateMessageIDV2, isJidGroup, type WAMessage, type proto } from '@whiskeysockets/baileys';
import { z } from 'zod';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
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
  /** Short plain text for a tappable button. Without it the label is used, shortened to fit. */
  button?: string;
  /** When the menu goes out as a pick-list, also show this option as a button next to it. */
  shortcut?: boolean;
}

/**
 * How a menu looks when tappable menus are on:
 * `buttons` the first options as buttons and the rest behind "More options", `list` a pick-list,
 * `auto` buttons for up to three options and a pick-list otherwise.
 */
export type MenuStyle = 'auto' | 'buttons' | 'list';

/** A button that opens a web address. */
export interface LinkButton {
  label: string;
  url: string;
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

/** Ids of the buttons we attach: "bbot:<menu message id>:<number>". */
const BUTTON_PREFIX = 'bbot:';
const BUTTON_TEXT_MAX = 20;
/** WhatsApp shows three buttons under a message; any more are folded away and look cluttered. */
const MAX_BUTTONS = 3;
const MAX_SHORTCUTS = MAX_BUTTONS - 1;
const TAP_HINT = quote(italic('Tap a button to choose'));

interface FlowButton {
  name: string;
  buttonParamsJson: string;
}

/** Button and list labels are plain text: first line only, markup removed. */
function plain(label: string): string {
  return label
    .split('\n')[0]
    .replace(/[*_~`]/g, '')
    .trim();
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const buttonText = (option: MenuOption) => clip(option.button ?? plain(option.label), BUTTON_TEXT_MAX);
/** Does the button say everything the label does? Then the numbered text can be left out. */
const fitsButton = (option: MenuOption) => Boolean(option.button) || (!option.label.includes('\n') && plain(option.label).length <= BUTTON_TEXT_MAX);

/**
 * Send an interactive message: text with buttons under it, and optionally a picture on top.
 *
 * WhatsApp documents these only for the Business API. From an ordinary linked
 * device they are sent in the same wire format and render on current phones,
 * but nothing guarantees it, which is why this is an opt-in setting.
 * @returns the id of the sent message
 */
async function relayInteractive(
  bot: BotSession,
  jid: string,
  content: { messageId: string; text: string; buttons: FlowButton[]; image?: Buffer; quoted?: WAMessage }
): Promise<string> {
  // The picture rides in the header. Losing it is better than losing the whole message.
  const picture = content.image
    ? await bot.uploadImage(content.image).catch(err => {
        log.warn({ err }, 'could not attach the picture to an interactive message');
        return undefined;
      })
    : undefined;
  const { quoted } = content;

  const message: proto.IMessage = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: {
          ...(picture ? { header: { title: '', hasMediaAttachment: true, imageMessage: picture } } : {}),
          body: { text: content.text },
          footer: { text: getSettings().branding.botName },
          nativeFlowMessage: { buttons: content.buttons },
          ...(quoted ? { contextInfo: { stanzaId: quoted.key.id, participant: quoted.key.participant ?? quoted.key.remoteJid, quotedMessage: quoted.message } } : {})
        }
      }
    }
  };
  return bot.relay(jid, message, {
    messageId: content.messageId,
    // Tells the recipient's app to treat the payload as a native-flow (button) message.
    additionalNodes: [
      {
        tag: 'biz',
        attrs: {},
        content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }]
      }
    ]
  });
}

/**
 * The buttons of a menu, never more than three:
 * every option as a button when they fit, otherwise the leading ones (or the shortcuts of a
 * pick-list) as buttons and one more that opens a list of the others.
 */
function menuButtons(options: MenuOption[], messageId: string, asButtons: boolean): FlowButton[] {
  const numbered = options.map((option, index) => ({ option, index }));
  const optionId = (index: number) => `${BUTTON_PREFIX}${messageId}:${index + 1}`;
  const quickReply = (item: (typeof numbered)[number]): FlowButton => ({
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({ display_text: buttonText(item.option), id: optionId(item.index) })
  });
  if (asButtons && options.length <= MAX_BUTTONS) return numbered.map(quickReply);

  const direct = asButtons ? numbered.slice(0, MAX_SHORTCUTS) : numbered.filter(item => item.option.shortcut).slice(0, MAX_SHORTCUTS);
  const listed = asButtons ? numbered.slice(MAX_SHORTCUTS) : numbered;
  const list: FlowButton = {
    name: 'single_select',
    buttonParamsJson: JSON.stringify({
      title: asButtons ? 'More options' : 'Choose',
      // Lists show at most ten rows per section.
      sections: Array.from({ length: Math.ceil(listed.length / 10) }, (_, page) => ({
        title: listed.length > 10 ? `Options ${page * 10 + 1} to ${Math.min(listed.length, page * 10 + 10)}` : 'Options',
        rows: listed.slice(page * 10, page * 10 + 10).map(({ option, index }) => {
          const [first, ...others] = option.label.split('\n');
          // An option with its own button text is titled by it; what the label adds is the description.
          const title = option.button ?? plain(first);
          const extra = option.button && plain(first).startsWith(title) ? plain(first).slice(title.length) : option.button ? plain(first) : '';
          return { title: clip(title, 24), description: clip(plain([extra, ...others].join(' ')), 70), id: optionId(index) };
        })
      }))
    })
  };
  // Buttons first when they are the main choices; the list first when it is the menu itself.
  return asButtons ? [...direct.map(quickReply), list] : [list, ...direct.map(quickReply)];
}

/**
 * Send a numbered menu and register it.
 * @param header everything above the options (usually a card)
 * @param image shown above the menu (the menu becomes the image caption)
 * @param style how it looks when tappable menus are switched on; plain text menus ignore it
 */
export async function sendMenu(
  bot: BotSession,
  jid: string,
  menu: { header: string; options: MenuOption[]; footer?: string; quoted?: WAMessage; mentions?: string[]; image?: Buffer; style?: MenuStyle }
): Promise<void> {
  const options = menu.options.slice(0, MAX_OPTIONS);
  const text = [menu.header, '', numberedOptions(options), '', menu.footer ?? MENU_HINT].join('\n');

  let messageId: string | undefined;
  if (getSettings().menus.buttons) {
    const asButtons = menu.style === 'buttons' || (menu.style !== 'list' && options.length <= MAX_BUTTONS);
    try {
      const id = generateMessageIDV2(bot.requireSock().user?.id);
      messageId = await relayInteractive(bot, jid, {
        messageId: id,
        // Buttons that say it all replace the numbered text; replying with a number still works.
        text: asButtons && options.every(fitsButton) ? [menu.header, '', TAP_HINT].join('\n') : text,
        buttons: menuButtons(options, id, asButtons),
        image: menu.image,
        quoted: menu.quoted
      });
    } catch (err) {
      log.warn({ err }, 'could not send an interactive menu; sending it as text');
    }
  }
  if (!messageId) {
    const content = menu.image ? { image: menu.image, caption: text, mentions: menu.mentions } : { text, mentions: menu.mentions };
    const sent = await bot.send(jid, content, menu.quoted ? { quoted: menu.quoted } : undefined);
    messageId = sent?.key.id ?? undefined;
  }
  if (messageId) await registerPrompt(bot.id, jid, messageId, options);
}

/**
 * Send a card with link buttons under it (tappable menus only).
 * @returns false when buttons are switched off or the send failed, so the caller can send its plain version
 */
export async function sendLinkCard(bot: BotSession, jid: string, content: { text: string; links: LinkButton[]; image?: Buffer; quoted?: WAMessage }): Promise<boolean> {
  if (!getSettings().menus.buttons || content.links.length === 0) return false;
  try {
    await relayInteractive(bot, jid, {
      messageId: generateMessageIDV2(bot.requireSock().user?.id),
      text: content.text,
      buttons: content.links.map(link => ({
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({ display_text: clip(link.label, BUTTON_TEXT_MAX), url: link.url, merchant_url: link.url })
      })),
      image: content.image,
      quoted: content.quoted
    });
    return true;
  } catch (err) {
    log.warn({ err }, 'could not send a card with link buttons; sending it as text');
    return false;
  }
}

export type MenuReply = { option: MenuOption } | { outOfRange: number };

/** The id carried by a tapped button or picked list row, in any of the shapes WhatsApp uses. */
function tappedId(message: proto.IMessage | null | undefined): string | undefined {
  const content = contentOf(message);
  if (!content) return undefined;
  const flow = content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (flow) {
    try {
      const id = (JSON.parse(flow) as { id?: string }).id;
      if (id) return id;
    } catch {
      // not ours
    }
  }
  return (
    content.templateButtonReplyMessage?.selectedId ??
    content.buttonsResponseMessage?.selectedButtonId ??
    content.listResponseMessage?.singleSelectReply?.selectedRowId ??
    undefined
  );
}

/**
 * Is this message an answer to one of our menus?
 * Matches a tapped button, a reply quoting the menu message with a number, or in
 * private chats a bare number sent shortly after a menu.
 */
export async function resolveMenuReply(bot: BotSession, msg: WAMessage): Promise<MenuReply | undefined> {
  const jid = msg.key.remoteJid;
  if (!jid) return undefined;
  const content = contentOf(msg.message);

  const tapped = tappedId(msg.message);
  const viaButton = tapped?.startsWith(BUTTON_PREFIX) ? tapped.slice(BUTTON_PREFIX.length).split(':') : undefined;
  const text = viaButton ? (viaButton[1] ?? '') : textOf(content).trim();
  if (!/^\d{1,2}$/.test(text)) return undefined;

  const quotedId = viaButton ? viaButton[0] : contextInfoOf(content)?.stanzaId;
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
