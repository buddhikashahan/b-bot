import { scoped } from '../logger.js';
import { getSettings, updateSettings } from '../settings.js';
import { userPart } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { AiError, ask } from './ai.js';
import { parseMediaUrl } from './downloader.js';

// 18+ commands and the age gate in front of them.
//
// Off unless the owner switches them on. Even then they work only in private chats, and only
// for people confirmed as adults: by an owner, or by showing an identity document that the AI
// reads the date of birth from.
//
// What the check is and is not: it reads a date from a photo. It cannot tell whether the
// document is genuine or belongs to the person sending it, so it keeps honest people honest
// and nothing more. The photo is passed to the AI and not kept; only the outcome is stored.

const log = scoped('adult');

export const ADULT_AGE = 18;
/** Sites the adult download commands accept. */
const ADULT_DOMAINS = ['pornhub.com', 'pornhub.org'];
/** Attempts at the document check per person per day, so it cannot be worn down by trying pictures. */
const MAX_ATTEMPTS_PER_DAY = 3;

const attempts = new Map<string, number[]>();

/** A link to one of the adult sites, checked like any other download link; undefined otherwise. */
export function parseAdultUrl(input: string): string | undefined {
  const url = parseMediaUrl(input);
  if (!url) return undefined;
  const host = new URL(url).hostname.toLowerCase();
  return ADULT_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`)) ? url : undefined;
}

export const adultSearchUrl = (query: string) => `https://www.pornhub.com/video/search?search=${encodeURIComponent(query)}`;

/** Has this person been confirmed as an adult? `id` is their number (or other WhatsApp id) without the domain. */
export function isVerifiedAdult(sender: string): boolean {
  return getSettings().adult.verified.includes(userPart(sender));
}

export async function setVerifiedAdult(sender: string, verified: boolean): Promise<void> {
  const id = userPart(sender);
  const current = getSettings().adult.verified;
  if (current.includes(id) === verified) return;
  await updateSettings({ adult: { verified: verified ? [...current, id] : current.filter(item => item !== id) } });
}

/** May this person try the document check now? Counts the attempt when they may. */
export function takeAttempt(sender: string): boolean {
  const now = Date.now();
  const recent = (attempts.get(sender) ?? []).filter(time => now - time < 24 * 60 * 60 * 1000);
  if (recent.length >= MAX_ATTEMPTS_PER_DAY) return false;
  attempts.set(sender, [...recent, now]);
  if (attempts.size > 5000) for (const [key, times] of attempts) if (times.every(time => now - time >= 24 * 60 * 60 * 1000)) attempts.delete(key);
  return true;
}

const INSTRUCTION =
  'You check a photo for an age gate. Decide whether it shows a government-issued identity document ' +
  "(a national identity card, a passport or a driving licence) and read its holder's date of birth. " +
  'A screenshot of typed text, a handwritten note, a birthday card or a photo of a person is not such a document. ' +
  'On Sri Lankan identity cards with no printed date, the year of birth is the first two digits of an old nine-digit number (read as 19YY) ' +
  'or the first four digits of a new twelve-digit number. Never guess a date you cannot read. ' +
  'Reply with one JSON object and nothing else: {"document": true or false, "dateOfBirth": "YYYY-MM-DD" or null, "birthYear": a number or null, "legible": true or false}.';

export type AgeCheck = { adult: true } | { adult: false; reason: 'not-a-document' | 'unreadable' | 'under-age' | 'unavailable' };

/** Full years between a date of birth and today. */
export function ageOn(birth: Date, today = new Date()): number {
  const years = today.getUTCFullYear() - birth.getUTCFullYear();
  const hadBirthday = today.getUTCMonth() > birth.getUTCMonth() || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() >= birth.getUTCDate());
  return hadBirthday ? years : years - 1;
}

/** Turn the AI's reading of a document into a decision. The arithmetic is done here, not by the model. */
export function judgeAgeProof(reading: string, today = new Date()): AgeCheck {
  let parsed: { document?: unknown; dateOfBirth?: unknown; birthYear?: unknown; legible?: unknown };
  try {
    parsed = JSON.parse(/\{[\s\S]*\}/.exec(reading)?.[0] ?? '');
  } catch {
    return { adult: false, reason: 'unreadable' };
  }
  if (parsed.document !== true) return { adult: false, reason: 'not-a-document' };
  const exact = typeof parsed.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.dateOfBirth) ? new Date(`${parsed.dateOfBirth}T00:00:00Z`) : undefined;
  // Only the year is known: assume the latest possible birthday, so nobody gains a year from it.
  const year = Number(parsed.birthYear);
  const birth = exact && !Number.isNaN(exact.getTime()) ? exact : Number.isInteger(year) ? new Date(Date.UTC(year, 11, 31)) : undefined;
  if (parsed.legible === false || !birth) return { adult: false, reason: 'unreadable' };
  const age = ageOn(birth, today);
  // An age no living person has means the date was misread.
  if (age > 110) return { adult: false, reason: 'unreadable' };
  return age >= ADULT_AGE ? { adult: true } : { adult: false, reason: 'under-age' };
}

/**
 * Look at a photo of an identity document and decide whether its holder is an adult.
 * The photo goes to the AI for this one question and is kept nowhere.
 */
export async function checkAgeProof(bot: BotSession, chatJid: string, photo: Buffer): Promise<AgeCheck> {
  try {
    const reading = await ask(bot, { chatJid, text: 'Check this document.', image: photo, stateless: true, instruction: INSTRUCTION });
    return judgeAgeProof(reading);
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    log.warn(`the age check could not run: ${error.message}`);
    return { adult: false, reason: error.kind === 'blocked' ? 'unreadable' : 'unavailable' };
  }
}
