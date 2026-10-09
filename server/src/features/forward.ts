import { getContentType, jidNormalizedUser, type WAMessage } from '@whiskeysockets/baileys';
import { contentOf, kindOf, phoneToJid } from '../whatsapp/message-utils.js';

// Forwarding to several chats at once.
//
// A WhatsApp message with a file does not contain the file: it carries the address of the
// encrypted upload on WhatsApp's servers and the key to open it. Forwarding copies that small
// message, so a 2 GB video goes to ten chats as fast as a line of text, and nothing is
// downloaded or uploaded by this server.

/** More targets than this in one go starts to look like bulk messaging to WhatsApp. */
export const MAX_FORWARD_TARGETS = 25;

const CHAT_ID = /^\d{5,20}(-\d{5,20})?@(s\.whatsapp\.net|c\.us|g\.us|lid|newsletter)$/;
/** Digits and the punctuation people put in phone numbers. */
const NUMBER_LIKE = /^[+\d()\-.]+$/;
/** The longest phone number there is (E.164). */
const MAX_DIGITS = 15;
/**
 * Fewer digits than this is a local number, or a piece of one, unless it is written with a "+".
 * Taking "771234567" at its word would send someone's file to whoever owns +7 712 345 67.
 */
const MIN_DIGITS_WITHOUT_PLUS = 10;
const MIN_DIGITS = 7;
const digitsOf = (text: string) => text.replace(/\D/g, '');

/** Is this a full international number? `explicit`: it was written with a leading "+". */
function isPhone(digits: string, explicit: boolean): boolean {
  return digits.length >= (explicit ? MIN_DIGITS : MIN_DIGITS_WITHOUT_PLUS) && digits.length <= MAX_DIGITS && !digits.startsWith('0');
}

/**
 * The chats named after the command: phone numbers with their country code, and chat IDs
 * (what the `jid` command shows), separated by spaces, commas or new lines. A number may be
 * written in pieces ("+94 76 686 6297", "+1 (415) 555-2671").
 *
 * This decides who receives a file, so it errs on the side of refusing: a number without a
 * country code is reported back, never guessed at.
 * @param mentioned people @mentioned in the message, who are targets as well
 * @returns the chats to forward to, and the words that are not a chat
 */
export function parseTargets(text: string, mentioned: string[] = []): { targets: string[]; unknown: string[] } {
  const targets = new Set<string>(mentioned.map(jid => jidNormalizedUser(jid)));
  const unknown: string[] = [];
  // Pieces of one number that are waiting for the rest of it.
  let pieces: string[] = [];
  const settle = () => {
    const digits = digitsOf(pieces.join(''));
    if (isPhone(digits, pieces[0].startsWith('+'))) targets.add(phoneToJid(digits));
    else unknown.push(...pieces);
    pieces = [];
  };

  for (const part of text.split(/[,;\n]+/)) {
    for (const raw of part.trim().split(/\s+/).filter(Boolean)) {
      const word = raw.replace(/^[<"']+|[>"',.]+$/g, '');
      // An @mention arrives both as text ("@9477...") and in `mentioned`; the text copy is not a second target.
      if (!word || /^@\d+$/.test(word)) continue;
      const numeric = NUMBER_LIKE.test(word);
      const digits = digitsOf(word).length;

      if (pieces.length) {
        const sofar = digitsOf(pieces.join('')).length;
        // After a "+" everything numeric belongs to that number until it is full; without one, only short pieces do.
        const continues = numeric && !word.startsWith('+') && sofar + digits <= MAX_DIGITS && (pieces[0].startsWith('+') || digits < MIN_DIGITS_WITHOUT_PLUS);
        if (continues) {
          pieces.push(word);
          continue;
        }
        settle();
      }
      if (CHAT_ID.test(word)) targets.add(jidNormalizedUser(word.replace('@c.us', '@s.whatsapp.net')));
      else if (numeric && digits < MIN_DIGITS_WITHOUT_PLUS) pieces.push(word);
      else if (numeric && isPhone(digitsOf(word), word.startsWith('+'))) targets.add(phoneToJid(digitsOf(word)));
      else unknown.push(raw);
    }
    if (pieces.length) settle();
  }
  return { targets: [...targets], unknown };
}

/**
 * The message to pass on, reduced to its content: no reply context, no delivery wrappers.
 * @param withoutCaption drop the caption (when the caption is the forward command itself)
 * @returns undefined when there is nothing a person could receive (a reaction, a deleted message...)
 */
export function forwardable(msg: WAMessage, withoutCaption = false): WAMessage | undefined {
  const content = contentOf(msg.message);
  const type = content ? getContentType(content) : undefined;
  if (!content || !type || kindOf(content) === 'other') return undefined;
  const inner = content[type];
  if (typeof inner === 'string') return { key: msg.key, message: { conversation: inner } };
  const copy: Record<string, unknown> = { ...(inner as object) };
  if (withoutCaption) delete copy.caption;
  return { key: msg.key, message: { [type]: copy } };
}
