import { isJidStatusBroadcast, type WAMessage } from '@whiskeysockets/baileys';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import {
  contentOf,
  contextInfoOf,
  displayNumber,
  isViewOnce,
  mediaContent,
  mediaOf,
  supportsCaption,
  textOf,
  timestampOf
} from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { bold, card, field, quote } from '../whatsapp/format.js';
import { recordActivity } from './activity.js';
import { describeOrigin, formatTime, mentionTag, RecentSet } from './common.js';

const log = scoped('view-once');

/** Ids of view-once messages already revealed, so each one is forwarded once. */
const revealed = new RecentSet();
/** Ids of withheld view-once messages we have already reported. */
const reported = new RecentSet();
/** How long to give the phone to answer a resend request before telling the owner. */
const RESEND_GRACE_MS = 12_000;

/**
 * Re-send view-once media as a normal message.
 * @param destination overrides the configured destination (used by the `.vv` command)
 * @returns true when media was revealed
 */
export async function revealViewOnce(bot: BotSession, msg: WAMessage, destination?: string): Promise<boolean> {
  const content = contentOf(msg.message);
  const media = mediaOf(content);
  if (!media) return false;

  const settings = getSettings().viewOnce;
  const target = destination ?? (settings.destination === 'chat' ? msg.key.remoteJid : bot.alertJid());
  if (!target) return false;

  const buffer = await bot.download(msg);
  const origin = await describeOrigin(bot, msg);
  const header = card('👁️', `View-once ${media.kind} revealed`, [
    `👤 ${field('From', `${mentionTag(origin.senderJid)}${msg.pushName ? ` (${msg.pushName})` : ''}`)}`,
    `💬 ${field('Chat', origin.chatLabel)}`,
    `🕒 ${field('Sent', formatTime(timestampOf(msg)))}`
  ]);
  const mentions = [origin.senderJid];

  // mediaContent never sets the viewOnce flag, so this goes out as ordinary media.
  if (supportsCaption(media.kind)) {
    const caption = media.caption ? `${header}\n\n${quote(media.caption)}` : header;
    await bot.send(target, mediaContent(media, buffer, caption, mentions));
  } else {
    await bot.send(target, { text: header, mentions });
    await bot.send(target, mediaContent(media, buffer));
  }
  if (msg.key.id) revealed.add(msg.key.id);
  log.info(`revealed view-once ${media.kind} from ${displayNumber(origin.senderJid)}`);
  recordActivity(bot.id, 'viewonce', `Revealed a view-once ${media.kind} from ${origin.senderLabel}`, {
    detail: origin.chatLabel,
    chat: msg.key.remoteJid ?? undefined
  });
  return true;
}

/**
 * WhatsApp did not deliver the media to this device, only a "view once" stub.
 * Ask the phone for the real payload (it sometimes obliges) and, if nothing
 * comes back, tell the owner how to capture it.
 */
export async function handleWithheldViewOnce(bot: BotSession, msg: WAMessage): Promise<void> {
  const settings = getSettings().viewOnce;
  const { remoteJid, id, participant, fromMe } = msg.key;
  if (!settings.enabled || fromMe || !id || !remoteJid || isJidStatusBroadcast(remoteJid)) return;
  if (revealed.has(id) || !reported.add(id)) return;

  const origin = await describeOrigin(bot, msg);
  log.info(
    `view-once from ${displayNumber(origin.senderJid)} was withheld by WhatsApp (linked devices only get a stub); asking the phone to share it`
  );
  // A minimal key: the phone rejects requests carrying fields it does not know.
  await bot.sock
    ?.requestPlaceholderResend(
      { remoteJid, fromMe: false, id, participant: participant ?? undefined },
      { key: msg.key, messageTimestamp: msg.messageTimestamp, pushName: msg.pushName }
    )
    .catch(err => log.warn({ err }, 'could not ask the phone to resend the view-once message'));

  const timer = setTimeout(() => {
    if (revealed.has(id)) return;
    log.warn(
      `the phone did not share the view-once from ${displayNumber(origin.senderJid)}; reply to it from your phone${settings.onReply ? '' : ' with the vv command'} to reveal it`
    );
    recordActivity(bot.id, 'viewonce', `View-once from ${origin.senderLabel} needs a reply to be revealed`, {
      detail: origin.chatLabel,
      chat: remoteJid
    });
    const target = bot.alertJid();
    if (!settings.notify || !target) return;
    const prefix = getSettings().commands.prefix;
    const how = settings.onReply
      ? `${bold('Reply to that message')} from your phone (any text works) and I will save a copy here.`
      : `Reply to that message with ${bold(`${prefix}vv`)} from your phone and I will save a copy here.`;
    void bot
      .send(target, {
        text: [
          card('👁️', 'View-once message received', [
            `👤 ${field('From', `${mentionTag(origin.senderJid)}${msg.pushName ? ` (${msg.pushName})` : ''}`)}`,
            `💬 ${field('Chat', origin.chatLabel)}`
          ]),
          '',
          quote(`WhatsApp only delivers view-once media to your phone, so I cannot open it on my own.\n${how}`)
        ].join('\n'),
        mentions: [origin.senderJid]
      })
      .catch(err => log.warn({ err }, 'could not send the view-once notice'));
  }, RESEND_GRACE_MS);
  timer.unref();
}

/** The media itself arrived (older delivery path, or the phone answered our resend request). */
export async function handleViewOnce(bot: BotSession, msg: WAMessage): Promise<void> {
  if (!getSettings().viewOnce.enabled || msg.key.fromMe || !msg.key.id) return;
  if (!msg.message) {
    if (msg.key.isViewOnce) await handleWithheldViewOnce(bot, msg);
    return;
  }
  if (!isViewOnce(msg.message) || !revealed.add(msg.key.id)) return;
  try {
    await revealViewOnce(bot, msg);
  } catch (err) {
    revealed.delete(msg.key.id);
    throw err;
  }
}

/**
 * A reply to a view-once message embeds the original, media keys included.
 * That makes any reply (the owner's own, from their phone, is the usual one)
 * enough to recover media WhatsApp never sent to this device.
 */
export async function handleViewOnceReply(bot: BotSession, msg: WAMessage): Promise<boolean> {
  const settings = getSettings().viewOnce;
  const chat = msg.key.remoteJid;
  if (!settings.enabled || !settings.onReply || !chat) return false;

  const content = contentOf(msg.message);
  // A reply that is itself a command (".vv") is the command's job, not ours.
  const commands = getSettings().commands;
  if (commands.enabled && textOf(content).trim().startsWith(commands.prefix)) return false;

  const context = contextInfoOf(content);
  const quoted = context?.quotedMessage;
  const quotedId = context?.stanzaId;
  if (!quoted || !quotedId || !isViewOnce(quoted)) return false;

  // Our own view-once messages need no rescuing.
  const author = context.participant ?? undefined;
  if (author && (await bot.isSelf(author))) return false;
  if (!revealed.add(quotedId)) return false;

  const original: WAMessage = {
    key: { remoteJid: chat, id: quotedId, fromMe: false, participant: author },
    message: quoted,
    messageTimestamp: msg.messageTimestamp
  };
  try {
    const done = await revealViewOnce(bot, original);
    if (!done) revealed.delete(quotedId);
    return done;
  } catch (err) {
    revealed.delete(quotedId);
    throw err;
  }
}
