import { isPnUser, jidNormalizedUser, type Contact, type WAMessage } from '@whiskeysockets/baileys';
import { bus } from '../bus.js';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';
import type { BotSession } from '../whatsapp/session.js';

const log = scoped('directory');

/** Last name we stored per contact, to avoid rewriting the same row on every message. */
const known = new Map<string, string>();
let queue: Promise<void> = Promise.resolve();

function pnJidOf(contact: Partial<Contact>): string | undefined {
  const candidate = [contact.phoneNumber, contact.id].find(id => id && isPnUser(id));
  return candidate ? jidNormalizedUser(candidate) : undefined;
}

/** Persist contacts pushed by WhatsApp (history sync, contact updates) for the target picker. */
export function saveContacts(sessionId: string, contacts: Partial<Contact>[]): void {
  const rows = contacts
    .map(contact => ({ jid: pnJidOf(contact), name: contact.name?.trim(), notify: contact.notify?.trim() }))
    .filter((row): row is { jid: string; name: string | undefined; notify: string | undefined } =>
      Boolean(row.jid && (row.name || row.notify))
    )
    .filter(row => known.get(`${sessionId}:${row.jid}`) !== `${row.name ?? ''}|${row.notify ?? ''}`);
  if (rows.length === 0) return;

  // Serialised so a large history sync can't flood the database with parallel writes.
  queue = queue
    .then(async () => {
      for (const row of rows) {
        const data = { ...(row.name ? { name: row.name } : {}), ...(row.notify ? { notify: row.notify } : {}) };
        await prisma.contact.upsert({
          where: { sessionId_jid: { sessionId, jid: row.jid } },
          create: { sessionId, jid: row.jid, ...data },
          update: data
        });
        known.set(`${sessionId}:${row.jid}`, `${row.name ?? ''}|${row.notify ?? ''}`);
      }
      bus.publish({ type: 'directory', data: { reason: 'contacts' } });
    })
    .catch(err => log.warn({ err }, 'failed to save contacts'));
}

/** Learn display names from people who message us. */
export function touchContact(sessionId: string, msg: WAMessage): void {
  if (msg.key.fromMe || !msg.pushName) return;
  const { key } = msg;
  const ids = key.participant ? [key.participant, key.participantAlt] : [key.remoteJid, key.remoteJidAlt];
  const jid = ids.find(id => id && isPnUser(id));
  if (jid) saveContacts(sessionId, [{ id: jid, notify: msg.pushName }]);
}

export interface TargetList {
  groups: { jid: string; name: string; size: number }[];
  contacts: { jid: string; name: string }[];
}

export async function listTargets(bot: BotSession, refresh = false): Promise<TargetList> {
  if (refresh && bot.connected) {
    await bot.refreshGroups().catch(err => log.warn({ err }, 'group refresh failed'));
  }
  const groups = bot
    .listGroups()
    .map(meta => ({ jid: meta.id, name: meta.subject || meta.id, size: meta.size ?? meta.participants.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rows = await prisma.contact.findMany({ where: { sessionId: bot.id } });
  const contacts = rows
    .map(row => ({ jid: row.jid, name: row.name || row.notify || `+${row.jid.split('@')[0]}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { groups, contacts };
}
