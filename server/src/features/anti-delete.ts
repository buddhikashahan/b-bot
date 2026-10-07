import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BufferJSON, isJidGroup, jidNormalizedUser, type WAMessage, type WAMessageKey, type proto } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import {
  contentOf,
  displayNumber,
  kindOf,
  mediaContent,
  mediaOf,
  supportsCaption,
  textOf,
  timestampOf,
  type MediaInfo
} from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { recordActivity } from './activity.js';
import { bold, card, field, italic, quote } from '../whatsapp/format.js';
import { describeOrigin, formatTime, mentionTag } from './common.js';

const log = scoped('anti-delete');

function extensionFor(mime: string): string {
  const subtype = mime.split('/')[1]?.split(';')[0]?.replace(/[^a-z0-9]/gi, '') ?? '';
  return subtype.slice(0, 8) || 'bin';
}

/** Content types that are bookkeeping rather than something a person "sent". */
function isCacheable(content: proto.IMessage | undefined): content is proto.IMessage {
  if (!content) return false;
  return !(
    content.protocolMessage ||
    content.reactionMessage ||
    content.pollUpdateMessage ||
    content.keepInChatMessage ||
    content.pinInChatMessage
  );
}

/** Remember an incoming message so it can be recovered if the sender deletes it. */
export async function cacheMessage(bot: BotSession, msg: WAMessage): Promise<void> {
  const settings = getSettings().antiDelete;
  const { remoteJid, id, fromMe } = msg.key;
  if (!settings.enabled || !remoteJid || !id || fromMe) return;
  const isGroup = Boolean(isJidGroup(remoteJid));
  if (isGroup ? !settings.groups : !settings.privateChats) return;

  const content = contentOf(msg.message);
  if (!isCacheable(content)) return;

  const origin = await describeOrigin(bot, msg);
  const media = mediaOf(content);
  const data = {
    remoteJid,
    senderJid: origin.senderJid,
    senderName: msg.pushName ?? null,
    fromMe: false,
    kind: kindOf(content),
    text: textOf(content) || null,
    raw: JSON.stringify(msg, BufferJSON.replacer),
    mediaMime: media?.mime ?? null,
    mediaName: media?.fileName ?? null,
    timestamp: timestampOf(msg),
    expiresAt: new Date(Date.now() + settings.ttlHours * 3_600_000)
  };
  await prisma.cachedMessage.upsert({
    where: { sessionId_messageId: { sessionId: bot.id, messageId: id } },
    create: { sessionId: bot.id, messageId: id, ...data },
    update: data
  });

  // The row is written first so a fast revoke still recovers the text; media follows.
  if (!media || !settings.cacheMedia || !bot.sock) return;
  if ((media.sizeBytes ?? 0) > settings.maxMediaMb * 1024 * 1024) return;
  try {
    const buffer = await bot.download(msg);
    const dir = path.join(config.paths.mediaCache, bot.id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id.replace(/[^\w-]/g, '_')}.${extensionFor(media.mime)}`);
    await writeFile(file, buffer);
    await prisma.cachedMessage.updateMany({
      where: { sessionId: bot.id, messageId: id },
      data: { mediaPath: file }
    });
  } catch (err) {
    log.debug({ err }, `could not cache media for ${id}`);
  }
}

/** Raw proto of a cached message, used to answer Baileys' retry requests. */
export async function lookupCachedMessage(sessionId: string, messageId: string): Promise<proto.IMessage | undefined> {
  const row = await prisma.cachedMessage.findUnique({
    where: { sessionId_messageId: { sessionId, messageId } },
    select: { raw: true }
  });
  if (!row) return undefined;
  try {
    return (JSON.parse(row.raw, BufferJSON.reviver) as WAMessage).message ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A message was deleted for everyone. Recover it from the cache and forward it
 * to the alert target.
 * @param deletedKey key of the message that was removed
 * @param deleterIds addresses of whoever removed it (an admin can delete someone else's message)
 */
export async function handleRevoke(bot: BotSession, deletedKey: WAMessageKey, deleterIds: string[] = []): Promise<void> {
  if (!getSettings().antiDelete.enabled || !deletedKey.id) return;
  const where = { sessionId: bot.id, messageId: deletedKey.id };

  // The same revoke reaches us through two Baileys events; claiming the row makes the alert single-shot.
  const claimed = await prisma.cachedMessage.updateMany({
    where: { ...where, revokedAt: null },
    data: { revokedAt: new Date() }
  });
  if (claimed.count === 0) return;
  const row = await prisma.cachedMessage.findUnique({ where: { sessionId_messageId: where } });
  const target = bot.alertJid();
  if (!row || !target) return;

  let original: WAMessage;
  try {
    original = JSON.parse(row.raw, BufferJSON.reviver) as WAMessage;
  } catch {
    return;
  }
  const origin = await describeOrigin(bot, original);
  const rows = [
    `👤 ${field('From', `${mentionTag(origin.senderJid)}${row.senderName ? ` (${row.senderName})` : ''}`)}`,
    `💬 ${field('Chat', origin.chatLabel)}`,
    `🕒 ${field('Sent', formatTime(row.timestamp))}`,
    `❌ ${field('Deleted', formatTime(new Date()))}`
  ];
  const deleters = deleterIds.map(id => jidNormalizedUser(id));
  if (origin.isGroup && deleters.length > 0 && deleters.every(id => !origin.senderIds.includes(id))) {
    const admin = deleters.find(id => id.endsWith('@s.whatsapp.net')) ?? (await bot.pnForLid(deleters[0])) ?? deleters[0];
    rows.push(`🛡️ ${field('Removed by', displayNumber(admin))}`);
  }
  const header = card('🗑️', 'Deleted message recovered', rows);
  const mentions = [origin.senderJid];

  const content = contentOf(original.message);
  const media = mediaOf(content);
  try {
    if (media) {
      await sendRecoveredMedia(bot, target, original, media, row.mediaPath, header, row.text, mentions);
    } else if (row.kind === 'text') {
      await bot.send(target, { text: `${header}\n\n${quote(row.text ?? '')}`, mentions });
    } else {
      // Contacts, locations, polls...: forward the original payload untouched.
      await bot.send(target, { text: header, mentions });
      await bot.send(target, { forward: original });
    }
    log.info(`recovered deleted ${row.kind} from ${displayNumber(origin.senderJid)}`);
    recordActivity(bot.id, 'deleted', `Recovered a deleted ${row.kind} from ${origin.senderLabel}`, {
      detail: row.text?.slice(0, 200) || origin.chatLabel,
      chat: row.remoteJid
    });
  } catch (err) {
    log.warn({ err }, 'could not forward deleted message');
    await bot
      .send(target, { text: `${header}\n\n${quote(italic(`The ${row.kind} itself could not be recovered.`))}`, mentions })
      .catch(() => {});
  }
}

/**
 * A message was edited. Report the text before and after, then remember the
 * new text so a later deletion recovers what was last on screen.
 */
export async function handleEdit(bot: BotSession, key: WAMessageKey, edited: proto.IMessage): Promise<void> {
  const settings = getSettings().antiDelete;
  if (!settings.enabled || !settings.edits || !key.id || key.fromMe) return;
  const where = { sessionId_messageId: { sessionId: bot.id, messageId: key.id } };
  const row = await prisma.cachedMessage.findUnique({ where });
  const after = textOf(contentOf(edited));
  if (!row || row.revokedAt || !after || after === row.text) return;
  await prisma.cachedMessage.update({ where, data: { text: after } });

  const target = bot.alertJid();
  if (!target) return;
  let original: WAMessage;
  try {
    original = JSON.parse(row.raw, BufferJSON.reviver) as WAMessage;
  } catch {
    return;
  }
  const origin = await describeOrigin(bot, original);
  await bot.send(target, {
    text: [
      card('✏️', 'Message edited', [
        `👤 ${field('From', `${mentionTag(origin.senderJid)}${row.senderName ? ` (${row.senderName})` : ''}`)}`,
        `💬 ${field('Chat', origin.chatLabel)}`,
        `🕒 ${field('Sent', formatTime(row.timestamp))}`
      ]),
      '',
      bold('Before'),
      quote(row.text ?? italic('no text')),
      '',
      bold('After'),
      quote(after)
    ].join('\n'),
    mentions: [origin.senderJid]
  });
  log.info(`reported an edit by ${displayNumber(origin.senderJid)}`);
  recordActivity(bot.id, 'edited', `${origin.senderLabel} edited a message`, { detail: after.slice(0, 200), chat: row.remoteJid });
}

async function sendRecoveredMedia(
  bot: BotSession,
  target: string,
  original: WAMessage,
  media: MediaInfo,
  cachedPath: string | null,
  header: string,
  caption: string | null,
  mentions: string[]
): Promise<void> {
  // Prefer our cached copy; otherwise the file is usually still on WhatsApp's servers for a while.
  const source = cachedPath ? { url: cachedPath } : await bot.download(original);
  if (supportsCaption(media.kind)) {
    const text = caption ? `${header}\n\n${quote(caption)}` : header;
    await bot.send(target, mediaContent(media, source, text, mentions));
  } else {
    await bot.send(target, { text: header, mentions });
    await bot.send(target, mediaContent(media, source));
  }
}

/** Drop cached messages (and their media files) that are past their TTL. */
export async function purgeExpiredMessages(): Promise<number> {
  let removed = 0;
  for (;;) {
    const rows = await prisma.cachedMessage.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: { id: true, mediaPath: true },
      take: 200
    });
    if (rows.length === 0) break;
    await Promise.all(rows.filter(row => row.mediaPath).map(row => rm(row.mediaPath!, { force: true })));
    await prisma.cachedMessage.deleteMany({ where: { id: { in: rows.map(row => row.id) } } });
    removed += rows.length;
  }
  if (removed) log.debug(`purged ${removed} expired cached messages`);
  return removed;
}
