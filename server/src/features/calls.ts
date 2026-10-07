import type { WACallEvent } from '@whiskeysockets/baileys';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import { displayNumber } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { recordActivity } from './activity.js';
import { RecentSet } from './common.js';

const log = scoped('calls');
const handled = new RecentSet(500);

/** Decline incoming calls and optionally tell the caller why. */
export async function handleCalls(bot: BotSession, calls: WACallEvent[]): Promise<void> {
  const settings = getSettings().calls;
  if (!settings.reject) return;
  for (const call of calls) {
    // "offer" is the ring; every later update for the same call is noise.
    if (call.status !== 'offer' || call.offline || !handled.add(call.id)) continue;
    const sock = bot.sock;
    if (!sock) return;

    await sock.rejectCall(call.id, call.from);
    const caller = call.callerPn ?? (await bot.pnForLid(call.from)) ?? call.from;
    const kind = call.isVideo ? 'video call' : 'call';
    log.info(`declined a ${kind} from ${displayNumber(caller)}`);
    recordActivity(bot.id, 'call', `Declined a ${kind} from ${displayNumber(caller)}`, { chat: caller });

    const message = settings.message.trim();
    if (message && !call.isGroup) {
      await bot.send(caller, { text: message }).catch(err => log.warn({ err }, 'could not message the caller'));
    }
  }
}
