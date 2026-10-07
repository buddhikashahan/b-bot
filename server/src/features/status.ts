import type { WAMessage } from '@whiskeysockets/baileys';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import {
  contentOf,
  displayNumber,
  mediaContent,
  mediaOf,
  supportsCaption,
  textOf,
  timestampOf
} from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { card, field, quote } from '../whatsapp/format.js';
import { recordActivity } from './activity.js';
import { describeOrigin, formatTime, mentionTag, RecentSet } from './common.js';

const log = scoped('status');
const handled = new RecentSet();

/** Auto-view and/or forward a contact's status (story) update. */
export async function handleStatus(bot: BotSession, msg: WAMessage): Promise<void> {
  const settings = getSettings().status;
  if ((!settings.autoView && !settings.forward) || msg.key.fromMe || !msg.key.id) return;

  const content = contentOf(msg.message);
  // Status deletions and reactions also travel over status@broadcast.
  if (!content || content.protocolMessage || content.reactionMessage) return;
  if (!handled.add(msg.key.id)) return;

  if (settings.autoView) {
    await bot.sock?.readMessages([msg.key]).catch(err => log.debug({ err }, 'could not mark status as viewed'));
  }
  if (!settings.forward) return;
  const target = bot.alertJid();
  if (!target) return;

  const origin = await describeOrigin(bot, msg);
  const header = card('📣', 'Status update', [
    `👤 ${field('From', `${mentionTag(origin.senderJid)}${msg.pushName ? ` (${msg.pushName})` : ''}`)}`,
    `🕒 ${field('Posted', formatTime(timestampOf(msg)))}`
  ]);
  const mentions = [origin.senderJid];
  const media = mediaOf(content);
  const text = textOf(content);

  if (!media) {
    if (!text) return;
    await bot.send(target, { text: `${header}\n\n${quote(text)}`, mentions });
    recordActivity(bot.id, 'status', `Forwarded a text status from ${origin.senderLabel}`, { detail: text.slice(0, 200) });
    return;
  }
  const buffer = await bot.download(msg);
  if (supportsCaption(media.kind)) {
    await bot.send(target, mediaContent(media, buffer, text ? `${header}\n\n${quote(text)}` : header, mentions));
  } else {
    await bot.send(target, { text: header, mentions });
    await bot.send(target, mediaContent(media, buffer));
  }
  log.info(`forwarded ${media.kind} status from ${displayNumber(origin.senderJid)}`);
  recordActivity(bot.id, 'status', `Forwarded a ${media.kind} status from ${origin.senderLabel}`);
}
