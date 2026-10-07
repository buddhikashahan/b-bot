import { isJidGroup, type WAMessage } from '@whiskeysockets/baileys';
import { scoped } from '../logger.js';
import { getSettings, type AutoReplyRule } from '../settings.js';
import { contentOf, textOf } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { recordActivity } from './activity.js';

const log = scoped('auto-reply');

/** Minimum gap between automatic replies in one chat, so two bots can't ping-pong forever. */
const CHAT_THROTTLE_MS = 5000;
const lastReply = new Map<string, number>();
const lastAway = new Map<string, number>();

export function matchesRule(rule: AutoReplyRule, text: string): boolean {
  const haystack = text.trim().toLowerCase();
  const needle = rule.trigger.trim().toLowerCase();
  if (!needle) return false;
  if (rule.match === 'exact') return haystack === needle;
  if (rule.match === 'starts') return haystack.startsWith(needle);
  return haystack.includes(needle);
}

function inScope(scope: AutoReplyRule['scope'], isGroup: boolean): boolean {
  return scope === 'all' || (scope === 'groups') === isGroup;
}

function render(template: string, msg: WAMessage): string {
  return template.replaceAll('{name}', msg.pushName?.trim() || 'there');
}

function trim(map: Map<string, number>): void {
  if (map.size < 5000) return;
  const cutoff = Date.now() - 86_400_000;
  for (const [key, time] of map) if (time < cutoff) map.delete(key);
}

/**
 * Answer with the first matching keyword rule.
 * @returns true when a reply was sent
 */
export async function handleKeywordReply(bot: BotSession, msg: WAMessage): Promise<boolean> {
  const settings = getSettings().autoReply;
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe || !settings.enabled) return false;
  const now = Date.now();
  if (now - (lastReply.get(jid) ?? 0) < CHAT_THROTTLE_MS) return false;

  const isGroup = Boolean(isJidGroup(jid));
  const text = textOf(contentOf(msg.message));
  const rule = text ? settings.rules.find(item => item.enabled && inScope(item.scope, isGroup) && matchesRule(item, text)) : undefined;
  if (!rule) return false;

  lastReply.set(jid, now);
  trim(lastReply);
  await bot.send(jid, { text: render(rule.response, msg) }, { quoted: msg });
  log.info(`replied to "${rule.trigger}" in ${isGroup ? 'a group' : 'a private chat'}`);
  recordActivity(bot.id, 'autoreply', `Auto-replied to "${rule.trigger}"`, { detail: msg.pushName ?? undefined, chat: jid });
  return true;
}

/**
 * Send the away message in a private chat, at most once per cooldown.
 * This is the last resort in the pipeline: it only runs when nothing else,
 * the AI assistant included, has answered the message.
 * @returns true when it was sent
 */
export async function handleAwayMessage(bot: BotSession, msg: WAMessage): Promise<boolean> {
  const settings = getSettings().autoReply;
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe || !settings.awayEnabled || isJidGroup(jid) || !settings.awayMessage.trim()) return false;
  const now = Date.now();
  if (now - (lastAway.get(jid) ?? 0) < settings.awayCooldownMinutes * 60_000) return false;

  lastAway.set(jid, now);
  lastReply.set(jid, now);
  trim(lastAway);
  await bot.send(jid, { text: render(settings.awayMessage, msg) });
  recordActivity(bot.id, 'autoreply', `Sent the away message to ${msg.pushName ?? 'a contact'}`, { chat: jid });
  return true;
}
