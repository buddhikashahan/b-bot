import { isJidGroup, isLidUser } from '@whiskeysockets/baileys';
import { getSettings, updateSettings } from '../settings.js';
import { phoneToJid, userPart } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';

/** Groups on the block list are invisible to the bot: no commands, no moderation, no capture. */
export function isChatBlocked(jid: string | null | undefined): boolean {
  return Boolean(jid && isJidGroup(jid) && getSettings().access.blockedChats.includes(jid));
}

/** Blocked people get no response from the bot (commands, auto-replies). */
export async function isUserBlocked(bot: BotSession, ids: string[]): Promise<boolean> {
  const blocked = getSettings().access.blockedUsers;
  if (blocked.length === 0) return false;
  const jids = new Set(blocked.map(phoneToJid));
  for (const id of ids) {
    if (jids.has(id)) return true;
    if (isLidUser(id)) {
      const pn = await bot.pnForLid(id);
      if (pn && jids.has(pn)) return true;
    }
  }
  return false;
}

/** Resolve a JID to a phone number we can store on the block list. */
export async function phoneOf(bot: BotSession, jid: string): Promise<string | undefined> {
  const pn = isLidUser(jid) ? await bot.pnForLid(jid) : jid;
  const digits = pn?.endsWith('@s.whatsapp.net') ? userPart(pn) : undefined;
  return digits && /^\d{6,16}$/.test(digits) ? digits : undefined;
}

export async function setUserBlocked(phone: string, blocked: boolean): Promise<boolean> {
  const current = getSettings().access.blockedUsers;
  if (current.includes(phone) === blocked) return false;
  await updateSettings({ access: { blockedUsers: blocked ? [...current, phone] : current.filter(item => item !== phone) } });
  return true;
}

export async function setChatBlocked(jid: string, blocked: boolean): Promise<boolean> {
  const current = getSettings().access.blockedChats;
  if (current.includes(jid) === blocked) return false;
  await updateSettings({ access: { blockedChats: blocked ? [...current, jid] : current.filter(item => item !== jid) } });
  return true;
}
