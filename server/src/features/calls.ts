import type { WACallEvent } from '@whiskeysockets/baileys';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import { displayNumber } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { recordActivity } from './activity.js';
import { RecentSet } from './common.js';
import { speak, type Speech } from './speech.js';

// WhatsApp calls cannot be picked up from a linked device: the library receives the ring but
// has no access to the call's audio. The nearest thing is to decline and answer by voice note.

const log = scoped('calls');
const handled = new RecentSet(500);

/** The spoken message is the same for every caller, so it is made once per wording and voice. */
let greeting: { text: string; voice: string; speech: Speech } | undefined;

async function voiceGreeting(text: string, voice: string): Promise<Speech> {
  if (greeting?.text === text && greeting.voice === voice) return greeting.speech;
  const speech = await speak(text, voice);
  greeting = { text, voice, speech };
  return speech;
}

/** Decline incoming calls and optionally tell the caller why, in text or by voice note. */
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

    if (call.isGroup) continue;
    let spoke = false;
    if (settings.voiceGreeting && settings.voiceMessage) {
      try {
        const speech = await voiceGreeting(settings.voiceMessage, getSettings().ai.voice);
        await bot.send(caller, { audio: speech.audio, mimetype: speech.mimetype, ptt: speech.voiceNote });
        spoke = true;
      } catch (err) {
        log.warn({ err }, 'could not send the voice message to the caller; sending the text instead');
      }
    }
    const message = settings.message.trim();
    if (message && !spoke) {
      await bot.send(caller, { text: message }).catch(err => log.warn({ err }, 'could not message the caller'));
    }
  }
}
