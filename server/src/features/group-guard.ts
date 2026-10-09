import type { GroupMetadata, GroupParticipant, ParticipantAction, WAMessage } from '@whiskeysockets/baileys';
import type { GroupSetting } from '@prisma/client';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import { contentOf, participantIds, senderIdsOf, textOf, userPart } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { recordActivity } from './activity.js';
import { findBadWord } from './bad-words.js';

const log = scoped('groups');

export type AntiLinkMode = 'whatsapp' | 'all';
export type AntiLinkAction = 'delete' | 'warn' | 'kick';
/** What happens to someone who breaks a rule of the group: the same three choices for every filter. */
export type GuardAction = AntiLinkAction;

// --- per-group settings ---------------------------------------------------------------------

const settingCache = new Map<string, GroupSetting | null>();
const cacheKey = (sessionId: string, jid: string) => `${sessionId}:${jid}`;

export async function getGroupSetting(sessionId: string, jid: string): Promise<GroupSetting | null> {
  const key = cacheKey(sessionId, jid);
  if (settingCache.has(key)) return settingCache.get(key)!;
  const row = await prisma.groupSetting.findUnique({ where: { sessionId_jid: { sessionId, jid } } });
  settingCache.set(key, row);
  return row;
}

export interface GroupSettingInput {
  name?: string;
  antiLink?: boolean;
  antiLinkMode?: AntiLinkMode;
  antiLinkAction?: AntiLinkAction;
  warnLimit?: number;
  antiBadWords?: boolean;
  badWordAction?: GuardAction;
  whitelist?: string[];
  welcomeEnabled?: boolean;
  welcomeTemplate?: string | null;
  farewellEnabled?: boolean;
  farewellTemplate?: string | null;
}

export async function saveGroupSetting(sessionId: string, jid: string, input: GroupSettingInput): Promise<GroupSetting> {
  const { whitelist, ...rest } = input;
  const data = { ...rest, ...(whitelist ? { whitelist: JSON.stringify(normalizeWhitelist(whitelist)) } : {}) };
  const row = await prisma.groupSetting.upsert({
    where: { sessionId_jid: { sessionId, jid } },
    create: { sessionId, jid, whitelist: '[]', ...data },
    update: data
  });
  settingCache.set(cacheKey(sessionId, jid), row);
  return row;
}

export function parseWhitelist(row: Pick<GroupSetting, 'whitelist'> | null): string[] {
  try {
    const parsed = JSON.parse(row?.whitelist ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeWhitelist(entries: string[]): string[] {
  const hosts = entries
    .map(entry => entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0])
    .filter(Boolean);
  return [...new Set(hosts)].slice(0, 100);
}

// --- anti-link ------------------------------------------------------------------------------

const WHATSAPP_LINK = /(?:chat\.whatsapp\.com\/[\w-]+|whatsapp\.com\/channel\/[\w-]+)/gi;
// Explicit URLs, plus bare domains on common TLDs (so "file.txt" or "e.g." don't trip the filter).
const ANY_LINK =
  /(?:https?:\/\/|www\.)[^\s<>]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|me|co|gg|ly|app|xyz|info|link|tv|to|dev|shop|site|online|club|biz|live|ru|in|uk|us|id|br|de)\b(?:\/[^\s<>]*)?/gi;

export function findLinks(text: string, mode: AntiLinkMode): string[] {
  return text.match(mode === 'whatsapp' ? WHATSAPP_LINK : ANY_LINK) ?? [];
}

function hostOf(link: string): string {
  return link.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
}

export function isWhitelisted(link: string, whitelist: string[]): boolean {
  const host = hostOf(link);
  return whitelist.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

const inviteCodes = new Map<string, { code: string | undefined; at: number }>();

/** The group's own invite link is always allowed. */
async function ownInviteCode(bot: BotSession, jid: string): Promise<string | undefined> {
  const cached = inviteCodes.get(jid);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.code;
  const code = await bot.sock?.groupInviteCode(jid).catch(() => undefined);
  inviteCodes.set(jid, { code, at: Date.now() });
  return code;
}

/**
 * Count a warning against a member, and remove them when the group's limit is reached
 * (after which they start from zero again).
 * @param userJid the id the count is kept under
 * @returns the count after this warning, and whether that was the last one
 */
export async function addWarning(sessionId: string, groupJid: string, userJid: string, limit: number): Promise<{ count: number; reachedLimit: boolean }> {
  const where = { sessionId_groupJid_userJid: { sessionId, groupJid, userJid } };
  const { count } = await prisma.groupWarning.upsert({ where, create: { ...where.sessionId_groupJid_userJid, count: 1 }, update: { count: { increment: 1 } } });
  if (count < limit) return { count, reachedLimit: false };
  await prisma.groupWarning.delete({ where });
  return { count, reachedLimit: true };
}

/**
 * Remove abusive language from a group: delete the message, then warn or remove its sender as
 * the group's settings say. Admins and bot owners are left alone.
 * @returns true when the message was removed
 */
export async function handleBadWords(bot: BotSession, msg: WAMessage): Promise<boolean> {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe || !msg.key.participant) return false;
  const setting = await getGroupSetting(bot.id, jid);
  if (!setting?.antiBadWords) return false;
  const word = findBadWord(textOf(contentOf(msg.message)), getSettings().moderation.badWords);
  if (!word) return false;

  const meta = await bot.groupMeta(jid);
  if (!meta) return false;
  const senderIds = senderIdsOf(msg);
  if (bot.isGroupAdmin(meta, senderIds) || (await bot.isOwner(senderIds))) return false;
  if (!bot.botIsAdmin(meta)) {
    log.debug(`the bad-language filter is on for "${meta.subject}" but the bot is not an admin there`);
    return false;
  }

  const sock = bot.requireSock();
  const offender = msg.key.participant;
  const tag = `@${userPart(offender)}`;
  await sock.sendMessage(jid, { delete: msg.key });

  const action = setting.badWordAction as GuardAction;
  if (action === 'kick') {
    await sock.groupParticipantsUpdate(jid, [offender], 'remove');
    bot.invalidateGroup(jid);
    await bot.send(jid, { text: `🚫 ${tag} was removed for abusive language.`, mentions: [offender] });
  } else if (action === 'warn') {
    const { count, reachedLimit } = await addWarning(bot.id, jid, senderIds[0] ?? offender, setting.warnLimit);
    if (reachedLimit) {
      await sock.groupParticipantsUpdate(jid, [offender], 'remove');
      bot.invalidateGroup(jid);
      await bot.send(jid, { text: `🚫 ${tag} reached ${setting.warnLimit}/${setting.warnLimit} warnings for abusive language and was removed.`, mentions: [offender] });
    } else {
      await bot.send(jid, { text: `⚠️ ${tag} keep it clean: that language is not allowed here. Warning ${count}/${setting.warnLimit}.`, mentions: [offender] });
    }
  } else {
    await bot.send(jid, { text: `🚫 ${tag} that language is not allowed in this group.`, mentions: [offender] });
  }
  log.info(`removed abusive language from ${tag} in "${meta.subject}" (${action})`);
  // The word itself stays out of the feed: the dashboard is not the place to read it again.
  recordActivity(bot.id, 'antilink', `Removed abusive language in ${meta.subject}`, { detail: `${msg.pushName ? `${msg.pushName} ` : ''}${tag} (${action})`, chat: jid });
  return true;
}

/**
 * Enforce the group's link policy on an incoming message.
 * @returns true when the message was removed
 */
export async function handleAntiLink(bot: BotSession, msg: WAMessage): Promise<boolean> {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe || !msg.key.participant) return false;
  const setting = await getGroupSetting(bot.id, jid);
  if (!setting?.antiLink) return false;

  const content = contentOf(msg.message);
  const text = [textOf(content), content?.extendedTextMessage?.matchedText, content?.groupInviteMessage ? 'chat.whatsapp.com/invite' : '']
    .filter(Boolean)
    .join(' ');
  const whitelist = parseWhitelist(setting);
  let links = findLinks(text, setting.antiLinkMode as AntiLinkMode).filter(link => !isWhitelisted(link, whitelist));
  if (links.length === 0) return false;

  const meta = await bot.groupMeta(jid);
  if (!meta) return false;
  const senderIds = senderIdsOf(msg);
  if (bot.isGroupAdmin(meta, senderIds) || (await bot.isOwner(senderIds))) return false;
  if (!bot.botIsAdmin(meta)) {
    log.debug(`anti-link is on for "${meta.subject}" but the bot is not an admin there`);
    return false;
  }
  const ownCode = await ownInviteCode(bot, jid);
  if (ownCode) links = links.filter(link => !link.includes(ownCode));
  if (links.length === 0) return false;

  const sock = bot.requireSock();
  const offender = msg.key.participant;
  const tag = `@${userPart(offender)}`;
  await sock.sendMessage(jid, { delete: msg.key });

  const action = setting.antiLinkAction as AntiLinkAction;
  if (action === 'kick') {
    await sock.groupParticipantsUpdate(jid, [offender], 'remove');
    await bot.send(jid, { text: `🚫 ${tag} was removed for sharing a link.`, mentions: [offender] });
  } else if (action === 'warn') {
    const warning = await addWarning(bot.id, jid, senderIds[0] ?? offender, setting.warnLimit);
    if (warning.reachedLimit) {
      await sock.groupParticipantsUpdate(jid, [offender], 'remove');
      await bot.send(jid, {
        text: `🚫 ${tag} reached ${setting.warnLimit}/${setting.warnLimit} warnings for sharing links and was removed.`,
        mentions: [offender]
      });
    } else {
      await bot.send(jid, {
        text: `⚠️ ${tag} links are not allowed here. Warning ${warning.count}/${setting.warnLimit}.`,
        mentions: [offender]
      });
    }
  } else {
    await bot.send(jid, { text: `🚫 ${tag} links are not allowed in this group.`, mentions: [offender] });
  }
  log.info(`removed a link from ${tag} in "${meta.subject}" (${action})`);
  recordActivity(bot.id, 'antilink', `Removed a link in ${meta.subject}`, {
    detail: `${msg.pushName ? `${msg.pushName} ` : ''}${tag}: ${links[0].slice(0, 120)} (${action})`,
    chat: jid
  });
  return true;
}

// --- welcome / farewell ---------------------------------------------------------------------

export function renderTemplate(template: string, meta: GroupMetadata, userJid: string): string {
  return template
    .replaceAll('{user}', `@${userPart(userJid)}`)
    .replaceAll('{group}', meta.subject ?? '')
    .replaceAll('{desc}', meta.desc ?? '')
    .replaceAll('{count}', String(meta.participants.length))
    .trim();
}

export async function handleParticipantsUpdate(
  bot: BotSession,
  event: { id: string; participants: GroupParticipant[]; action: ParticipantAction }
): Promise<void> {
  bot.invalidateGroup(event.id);
  if (event.action !== 'add' && event.action !== 'remove') return;
  const setting = await getGroupSetting(bot.id, event.id);
  const joining = event.action === 'add';
  if (!setting || !(joining ? setting.welcomeEnabled : setting.farewellEnabled)) return;

  const me = bot.me;
  const mine = new Set([me?.jid, me?.lid]);
  const members = event.participants.filter(p => !participantIds(p).some(id => mine.has(id)));
  if (members.length === 0) return;

  const meta = await bot.groupMeta(event.id, true);
  if (!meta) return;
  const defaults = getSettings().groups;
  const template = joining
    ? setting.welcomeTemplate || defaults.defaultWelcome
    : setting.farewellTemplate || defaults.defaultFarewell;

  for (const member of members) {
    await bot.send(event.id, { text: renderTemplate(template, meta, member.id), mentions: [member.id] });
  }
  const count = `${members.length} member${members.length === 1 ? '' : 's'}`;
  recordActivity(bot.id, 'member', `${joining ? 'Welcomed' : 'Said goodbye to'} ${count} in ${meta.subject}`, { chat: event.id });
}
