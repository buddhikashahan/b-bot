import {
  WAMessageStubType,
  decodeMessageNode,
  getBinaryNodeChild,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidNormalizedUser,
  proto,
  type BaileysEventMap,
  type BinaryNode,
  type WAMessage,
  type WASocket
} from '@whiskeysockets/baileys';
import { handleCommand } from '../commands/registry.js';
import { isChatBlocked, isUserBlocked } from '../features/access.js';
import { cacheMessage, handleEdit, handleRevoke, lookupCachedMessage } from '../features/anti-delete.js';
import { handleAssistant } from '../features/ai.js';
import { handleAwayMessage, handleKeywordReply } from '../features/auto-reply.js';
import { handleCalls } from '../features/calls.js';
import { saveContacts, touchContact } from '../features/directory.js';
import { handleAntiLink, handleParticipantsUpdate } from '../features/group-guard.js';
import { handleMenuTrigger, resolveMenuReply, sendCustomMenuById } from '../features/menus.js';
import { handleStatus } from '../features/status.js';
import { handleViewOnce, handleViewOnceReply, handleWithheldViewOnce } from '../features/view-once.js';
import { getSettings } from '../settings.js';
import { senderIdsOf } from './message-utils.js';
import type { BotSession } from './session.js';

export const lookupMessage = lookupCachedMessage;

/** Messages older than this are history, not something to react to. */
const MAX_AGE_SECONDS = 10 * 60;

async function handleMessage(bot: BotSession, msg: WAMessage, live: boolean): Promise<void> {
  const jid = msg.key.remoteJid;
  if (!jid || isJidNewsletter(jid)) return;
  if (isChatBlocked(jid)) {
    // A blocked group is ignored entirely, except that the owner can still run
    // commands there from their own phone (that is how they unblock it).
    if (live && msg.key.fromMe) await handleCommand(bot, msg).catch(err => bot.log.error({ err }, 'command failed'));
    return;
  }

  /** Run one feature without letting its failure stop the others. */
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (err) {
      bot.log.error({ err }, `${name} failed for message ${msg.key.id}`);
      return undefined;
    }
  };

  const revoked = msg.message?.protocolMessage;
  if (revoked?.type === proto.Message.ProtocolMessage.Type.REVOKE && revoked.key) {
    const deletedKey = revoked.key;
    await step('anti-delete', () => handleRevoke(bot, deletedKey, msg.key.fromMe ? [] : senderIdsOf(msg)));
    return;
  }
  if (!live) return;

  if (isJidStatusBroadcast(jid)) {
    await step('status', () => handleStatus(bot, msg));
    return;
  }

  touchContact(bot.id, msg);
  if (!msg.key.fromMe && getSettings().general.autoRead && msg.message) {
    await step('auto-read', async () => bot.sock?.readMessages([msg.key]));
  }
  await step('view-once', () => handleViewOnce(bot, msg));
  await step('view-once reply', () => handleViewOnceReply(bot, msg));
  await step('anti-delete cache', () => cacheMessage(bot, msg));
  if (isJidGroup(jid)) {
    const removed = await step('anti-link', () => handleAntiLink(bot, msg));
    if (removed) return;
  }

  // Blocked people are still monitored (anti-delete, view-once) but never answered.
  if (!msg.key.fromMe && (await isUserBlocked(bot, senderIdsOf(msg)))) return;

  // A number answering one of our menus takes priority over everything else.
  const choice = await step('menu reply', () => resolveMenuReply(bot, msg));
  if (choice) {
    await step('menu choice', async () => {
      if ('outOfRange' in choice) {
        await bot.send(jid, { text: `❌ *Not on the menu*\n> Reply with a number from 1 to ${choice.outOfRange}.` }, { quoted: msg });
        return;
      }
      const { action } = choice.option;
      if (action.type === 'command') await handleCommand(bot, msg, action.text);
      else if (action.type === 'menu') await sendCustomMenuById(bot, msg, action.menuId);
      else await bot.send(jid, { text: action.text.replaceAll('{name}', msg.pushName?.trim() || 'there') }, { quoted: msg });
    });
    return;
  }

  // Then, first match wins: a command, a dashboard menu, a keyword reply, the AI assistant,
  // and only if none of those answered, the away message. The assistant already speaks for
  // the owner, so "I'm away" on top of its answer would just be noise.
  if (await step('command', () => handleCommand(bot, msg))) return;
  if (await step('menu', () => handleMenuTrigger(bot, msg))) return;
  if (await step('keyword reply', () => handleKeywordReply(bot, msg))) return;
  if (await step('assistant', () => handleAssistant(bot, msg))) return;
  await step('away message', () => handleAwayMessage(bot, msg));
}

/**
 * Baileys acknowledges and discards "view once, open it on your phone" stubs
 * before any event fires, so watch the raw stanzas for them ourselves.
 */
function watchWithheldViewOnce(bot: BotSession, sock: WASocket, isCurrent: () => boolean): void {
  sock.ws.on('CB:message', (node: BinaryNode) => {
    try {
      const type = getBinaryNodeChild(node, 'unavailable')?.attrs?.type;
      const me = bot.me;
      if (!isCurrent() || !me || !type?.startsWith('view_once')) return;
      const { fullMessage } = decodeMessageNode(node, me.jid, me.lid ?? '');
      if (isChatBlocked(fullMessage.key.remoteJid)) return;
      fullMessage.key.isViewOnce = true;
      void handleWithheldViewOnce(bot, fullMessage).catch(err => bot.log.error({ err }, 'view-once stub handler failed'));
    } catch (err) {
      bot.log.debug({ err }, 'could not inspect message stanza');
    }
  });
}

/** Wire a freshly created socket to the feature pipeline. */
export function attachHandlers(bot: BotSession, sock: WASocket, isCurrent: () => boolean): void {
  const on = <E extends keyof BaileysEventMap>(event: E, handler: (data: BaileysEventMap[E]) => Promise<void> | void) => {
    sock.ev.on(event, data => {
      if (!isCurrent()) return;
      Promise.resolve()
        .then(() => handler(data))
        .catch(err => bot.log.error({ err }, `${event} handler failed`));
    });
  };

  watchWithheldViewOnce(bot, sock, isCurrent);

  on('messages.upsert', async ({ messages, type, requestId }) => {
    const now = Date.now() / 1000;
    for (const msg of messages) {
      const age = now - Number(msg.messageTimestamp ?? now);
      // "notify" = arrived live; a requestId marks a payload the phone resent on request (view-once stubs).
      const live = (type === 'notify' || Boolean(requestId)) && age < MAX_AGE_SECONDS;
      await handleMessage(bot, msg, live);
    }
  });

  on('messages.update', async updates => {
    for (const { key, update } of updates) {
      if (isChatBlocked(key.remoteJid)) continue;
      const edited = update.message?.editedMessage?.message;
      if (edited) {
        await handleEdit(bot, key, edited);
        continue;
      }
      // Baileys also reports "delete for everyone" here; handleRevoke de-duplicates.
      if (update.messageStubType !== WAMessageStubType.REVOKE) continue;
      const deleter = key.participant ?? (key.fromMe ? undefined : key.remoteJid);
      await handleRevoke(bot, key, deleter ? [jidNormalizedUser(deleter)] : []);
    }
  });

  on('call', calls => handleCalls(bot, calls));

  on('group-participants.update', event => {
    if (isChatBlocked(event.id)) return bot.invalidateGroup(event.id);
    return handleParticipantsUpdate(bot, event);
  });
  on('groups.update', updates => {
    for (const update of updates) if (update.id) bot.invalidateGroup(update.id);
  });
  on('groups.upsert', groups => {
    for (const group of groups) bot.invalidateGroup(group.id);
  });

  on('contacts.upsert', contacts => saveContacts(bot.id, contacts));
  on('contacts.update', contacts => saveContacts(bot.id, contacts));
  on('messaging-history.set', ({ contacts }) => saveContacts(bot.id, contacts));
}
