import { isJidGroup, type WAMessage } from '@whiskeysockets/baileys';
import type { BotSession } from '../whatsapp/session.js';
import { displayNumber, preferPn, senderIdsOf, userPart } from '../whatsapp/message-utils.js';

export function formatTime(date: Date): string {
  return date.toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

export interface Origin {
  /** JID to @mention for the sender. */
  senderJid: string;
  senderIds: string[];
  senderLabel: string;
  chatLabel: string;
  isGroup: boolean;
}

/** Who sent a message and where, resolved to the friendliest form we can get. */
export async function describeOrigin(bot: BotSession, msg: WAMessage): Promise<Origin> {
  const ids = senderIdsOf(msg);
  let senderJid = preferPn(ids) ?? msg.key.remoteJid ?? '';
  if (!senderJid.endsWith('@s.whatsapp.net')) {
    senderJid = (await bot.pnForLid(senderJid)) ?? senderJid;
  }
  const name = msg.pushName?.trim();
  const senderLabel = name ? `${name} (${displayNumber(senderJid)})` : displayNumber(senderJid);

  const chat = msg.key.remoteJid ?? '';
  const isGroup = Boolean(isJidGroup(chat));
  let chatLabel = 'Private chat';
  if (isGroup) {
    const meta = await bot.groupMeta(chat);
    chatLabel = meta?.subject ? `${meta.subject} (group)` : 'Group chat';
  } else if (chat === 'status@broadcast') {
    chatLabel = 'Status';
  }
  return { senderJid, senderIds: ids, senderLabel, chatLabel, isGroup };
}

export function mentionTag(jid: string): string {
  return `@${userPart(jid)}`;
}

/** Tiny bounded set for "have I already handled this id" checks. */
export class RecentSet {
  private readonly items = new Set<string>();
  constructor(private readonly limit = 2000) {}

  has(id: string): boolean {
    return this.items.has(id);
  }

  delete(id: string): void {
    this.items.delete(id);
  }

  /** Returns true the first time an id is seen. */
  add(id: string): boolean {
    if (this.items.has(id)) return false;
    this.items.add(id);
    if (this.items.size > this.limit) this.items.delete(this.items.values().next().value!);
    return true;
  }
}
