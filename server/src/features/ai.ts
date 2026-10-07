import { isJidGroup, type WAMessage } from '@whiskeysockets/baileys';
import sharp from 'sharp';
import { isSealed, seal, unseal } from '../auth/secret.js';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';
import { getInternal, getSettings, setInternal } from '../settings.js';
import { contentOf, contextInfoOf, textOf } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { recordActivity } from './activity.js';

// The AI assistant: Google Gemini over its REST API (no SDK needed).
// Docs: https://ai.google.dev/api/generate-content

const log = scoped('ai');

/** Overridable so tests can point at a local stand-in for the API. */
const API_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const KEY_SETTING = 'geminiApiKey';
/** Listing models is a metadata call and answers in well under a second. */
const LIST_TIMEOUT_MS = 20_000;
/** Overrides every answer timeout (tests). */
const TIMEOUT_OVERRIDE_MS = Number(process.env.GEMINI_TIMEOUT_MS) || undefined;
/** How long to wait for an answer when a backup model is still available, per answer speed. */
const PATIENCE_MS = { low: 20_000, medium: 40_000, high: 75_000 } as const;
/**
 * How long the main model gets a head start before the backup is asked as well.
 * Whichever answers first is used, so a silent main model costs seconds, not its whole timeout.
 */
const HEAD_START_MS = { low: 7_000, medium: 20_000, high: 45_000 } as const;
/** How long to wait when there is nothing left to fall back to. */
const LAST_RESORT_MS = 90_000;
/** A model that failed to answer is skipped for this long, so every reply does not wait on it again. */
const COOL_DOWN_MS = 5 * 60_000;
const MAX_REPLY_CHARS = 3500;
/** Context older than this is stale: a chat picked up tomorrow starts fresh. */
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many automatic answers per chat per minute, so two bots cannot talk forever. */
const MAX_REPLIES_PER_MINUTE = 8;

export const DEFAULT_PROMPT =
  'You are a friendly, helpful assistant answering WhatsApp messages on behalf of the account owner. ' +
  'Be warm and to the point. If you do not know something, say so instead of guessing.';

/** Appended to every prompt, custom or not, because the output is shown in WhatsApp. */
const HOUSE_RULES =
  'You are replying inside WhatsApp. Keep answers short unless asked for detail. ' +
  'Format only with WhatsApp markup: *bold*, _italic_, ~strikethrough~, `code`, and lines starting with "- " for lists. ' +
  'Never use Markdown headings, tables or double asterisks. Reply in the language the person writes in.';

export type AiErrorKind = 'no-key' | 'bad-key' | 'model' | 'busy' | 'slow' | 'blocked' | 'network' | 'other';

/** A failure with a sentence that can be shown to a person. */
export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string
  ) {
    super(message);
  }
}

// --- API key ----------------------------------------------------------------------------------

let cachedKey: string | null | undefined;

/**
 * The key is stored encrypted with the instance secret, so a copy of the
 * database alone (a backup, a hosted database) does not reveal it.
 */
export async function getApiKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  const stored = await getInternal(KEY_SETTING);
  if (!stored) return (cachedKey = null);
  const key = unseal(stored);
  if (key === undefined) {
    log.warn('the saved API key cannot be decrypted (APP_SECRET or data/secret.key changed); add the key again in the dashboard');
    return (cachedKey = null);
  }
  // Keys saved before encryption was introduced are upgraded the first time they are read.
  if (!isSealed(stored)) await setInternal(KEY_SETTING, seal(key));
  return (cachedKey = key);
}

export async function setApiKey(key: string | null): Promise<void> {
  await setInternal(KEY_SETTING, key ? seal(key) : '');
  cachedKey = key;
  status.lastError = null;
}

/** Drop the in-memory copy so the next read comes from the database. */
export function forgetCachedApiKey(): void {
  cachedKey = undefined;
}

const status: {
  lastError: { message: string; at: number } | null;
  lastReplyAt: number | null;
  /** Model that produced the latest answer. */
  lastModel: string | null;
  /** Set while the main model is being skipped in favour of the backup. */
  notice: string | null;
} = { lastError: null, lastReplyAt: null, lastModel: null, notice: null };

export async function aiStatus() {
  const key = await getApiKey();
  return { configured: Boolean(key), keyHint: key ? `…${key.slice(-4)}` : null, ...status };
}

// --- Gemini REST calls ------------------------------------------------------------------------

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
interface Turn {
  role: 'user' | 'model';
  parts: Part[];
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

async function call<T>(path: string, key: string, body: unknown, timeoutMs: number, cancel?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: body ? 'POST' : 'GET',
      // The key travels in a header, never in the URL, so it cannot end up in a log line.
      headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: cancel ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const failure = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    // Google answered the connection but not the question in time: that is slowness, not a network fault.
    // We gave up on this request ourselves because another model answered first.
    if (cancel?.aborted) throw new AiError('slow', 'Cancelled: another model answered first.');
    if (failure.name === 'TimeoutError' || failure.name === 'AbortError') {
      log.warn(`Google did not answer within ${Math.round(timeoutMs / 1000)}s`);
      throw new AiError('slow', 'Google took too long to answer. Its servers may be overloaded for this model; try again shortly or choose another model on the AI assistant page.');
    }
    log.warn(`could not reach Google: ${failure.cause?.code ?? failure.cause?.message ?? failure.message ?? 'unknown error'}`);
    throw new AiError('network', 'Could not reach Google. Check the internet connection and try again.');
  }
  const data = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (response.ok) return data;

  const detail = data.error?.message ?? '';
  if (response.status === 401 || response.status === 403 || /api key/i.test(detail)) {
    throw new AiError('bad-key', 'Google rejected the API key. Check that it was copied completely and is still active.');
  }
  if (response.status === 404) throw new AiError('model', 'That AI model does not exist for this key. Pick another model in the dashboard.');
  if (response.status === 429) throw new AiError('busy', 'The AI quota for this key is used up for now. Try again in a little while.');
  if (response.status >= 500) {
    throw new AiError('busy', "Google's servers are overloaded for this model right now. Try again shortly or choose another model on the AI assistant page.");
  }
  throw new AiError('other', detail.slice(0, 200) || `The AI service returned an error (${response.status}).`);
}

/** Models that rejected the thinking setting (older ones have no such control). */
const withoutThinkingControl = new Set<string>();

/** One request to one model. */
async function generateWith(options: { key: string; model: string; system: string; turns: Turn[]; timeoutMs: number; cancel?: AbortSignal }): Promise<string> {
  const path = `/models/${encodeURIComponent(options.model)}:generateContent`;
  const request = (thinking: boolean) =>
    call<GenerateResponse>(
      path,
      options.key,
      {
        systemInstruction: { parts: [{ text: options.system }] },
        contents: options.turns,
        generationConfig: {
          // Thinking is billed against this limit too, so leave room for it and the answer.
          maxOutputTokens: 4096,
          ...(thinking ? { thinkingConfig: { thinkingLevel: getSettings().ai.thinking } } : {})
        }
      },
      TIMEOUT_OVERRIDE_MS ?? options.timeoutMs,
      options.cancel
    );

  let data: GenerateResponse;
  try {
    data = await request(!withoutThinkingControl.has(options.model));
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    if (error.kind === 'other' && /thinking/i.test(error.message) && !withoutThinkingControl.has(options.model)) {
      // This model does not take a thinking level: remember that and ask plainly.
      withoutThinkingControl.add(options.model);
      data = await request(false);
    } else {
      throw error;
    }
  }

  const candidate = data.candidates?.[0];
  // Newer models interleave their reasoning as "thought" parts; only the answer is for the chat.
  const text = (candidate?.content?.parts ?? [])
    .filter(part => !part.thought && part.text)
    .map(part => part.text)
    .join('')
    .trim();
  if (text) return text;
  if (data.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
    throw new AiError('blocked', "The AI declined to answer that because of Google's safety filters.");
  }
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new AiError('other', 'The AI used up its answer length while thinking. Choose a faster answer speed on the AI assistant page.');
  }
  throw new AiError('other', 'The AI returned an empty answer. Try rephrasing.');
}

/** Models that recently failed to answer, and until when to avoid them. */
const coolingDown = new Map<string, number>();

/** Capacity problems are the only failures another model can fix; a bad key or a safety block would fail there too. */
const isCapacityProblem = (error: unknown): error is AiError => error instanceof AiError && (error.kind === 'busy' || error.kind === 'slow');

type Outcome = { model: string; text: string } | { model: string; error: unknown };

/**
 * Ask the chosen model, with the backup model as a safety net. Newer models are
 * frequently at capacity at Google (HTTP 503, or no answer at all), and a chat
 * reply that arrives a little less clever beats one that never arrives.
 *
 * The main model gets a short head start. If it has not answered by then, the
 * backup is asked as well and whichever answers first wins; the other request
 * is cancelled. A model that failed is tried last for the next few minutes.
 */
export async function generate(options: { key: string; system: string; turns: Turn[] }): Promise<{ text: string; model: string }> {
  const settings = getSettings().ai;
  const chain = [...new Set([settings.model, settings.fallbackModel].filter(Boolean))];
  // Models that failed recently go to the back of the queue rather than out of it:
  // a struggling model is still better than no answer at all.
  const rested = chain.filter(model => (coolingDown.get(model) ?? 0) < Date.now());
  const [first, second] = [...rested, ...chain.filter(model => !rested.includes(model))];

  const cancelFirst = new AbortController();
  const cancelSecond = new AbortController();
  const attempt = (model: string, timeoutMs: number, cancel: AbortSignal): Promise<Outcome> =>
    generateWith({ ...options, model, timeoutMs, cancel }).then(
      text => ({ model, text }),
      error => ({ model, error })
    );
  const succeed = (outcome: { model: string; text: string }) => {
    coolingDown.delete(outcome.model);
    status.lastModel = outcome.model;
    status.notice =
      outcome.model === settings.model
        ? null
        : `Google is not answering for ${settings.model} at the moment, so replies are coming from the backup model ${outcome.model}.`;
    return outcome;
  };
  const benched = (model: string, why: string, next?: string) => {
    coolingDown.set(model, Date.now() + COOL_DOWN_MS);
    log.warn(`${model} did not answer (${why})${next ? `; using ${next}` : ''}`);
  };

  const primary = attempt(first, second ? PATIENCE_MS[settings.thinking] : LAST_RESORT_MS, cancelFirst.signal);
  if (!second) {
    const only = await primary;
    if ('text' in only) return succeed(only);
    if (isCapacityProblem(only.error)) benched(first, only.error.kind === 'slow' ? 'timed out' : 'overloaded');
    throw only.error;
  }

  // Head start for the main model.
  const headStart = TIMEOUT_OVERRIDE_MS ? TIMEOUT_OVERRIDE_MS / 2 : HEAD_START_MS[settings.thinking];
  let timer: NodeJS.Timeout | undefined;
  const early = await Promise.race([primary, new Promise<undefined>(resolve => (timer = setTimeout(() => resolve(undefined), headStart)))]);
  clearTimeout(timer);
  if (early && 'text' in early) return succeed(early);
  if (early && !isCapacityProblem(early.error)) throw early.error;
  if (early) benched(first, 'overloaded', second);

  // Either the main model already failed, or it is still silent: bring in the backup.
  const backup = attempt(second, LAST_RESORT_MS, cancelSecond.signal);
  const winner = early ? await backup : await Promise.race([primary, backup]);
  if ('text' in winner) {
    if (winner.model === second && !early) {
      cancelFirst.abort();
      benched(first, 'too slow', second);
    } else if (winner.model === first) {
      cancelSecond.abort();
    }
    return succeed(winner);
  }
  if (!isCapacityProblem(winner.error)) {
    cancelFirst.abort();
    cancelSecond.abort();
    throw winner.error;
  }
  benched(winner.model, winner.error.kind === 'slow' ? 'timed out' : 'overloaded');
  if (early) throw winner.error;

  // One of the two failed while racing; everything now rests on the other.
  const last = await (winner.model === first ? backup : primary);
  if ('text' in last) return succeed(last);
  if (isCapacityProblem(last.error)) benched(last.model, last.error.kind === 'slow' ? 'timed out' : 'overloaded');
  throw last.error;
}

/** Model ids this key can use for chat, newest first. */
export async function listModels(key: string): Promise<string[]> {
  const data = await call<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>('/models?pageSize=200', key, undefined, LIST_TIMEOUT_MS);
  return (data.models ?? [])
    .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
    .map(model => model.name.replace(/^models\//, ''))
    .filter(id => id.startsWith('gemini') && !/(tts|image|live|transcribe|embedding|banana|audio)/.test(id))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
}

/**
 * Prove a key works by listing the models it can use. That is a metadata
 * request: it answers at once and costs nothing, unlike asking a model to write.
 * @returns the chat models available to the key
 * @throws AiError with the reason when Google rejects the key
 */
export async function verifyKey(key: string): Promise<string[]> {
  return listModels(key);
}

// --- prompt and formatting ----------------------------------------------------------------------

export function systemPrompt(context: string): string {
  const persona = getSettings().ai.prompt.trim() || DEFAULT_PROMPT;
  return `${persona}\n\n${HOUSE_RULES}\n\n${context}`;
}

/** Models still slip into Markdown; translate the common cases to what WhatsApp renders. */
export function toWhatsApp(text: string): string {
  const cleaned = text
    .replace(/```[a-z0-9+-]*\n/gi, '```')
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')
    .replace(/__(.+?)__/gs, '_$1_')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^(\s*)[*•]\s+/gm, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > MAX_REPLY_CHARS ? `${cleaned.slice(0, MAX_REPLY_CHARS).trimEnd()}…` : cleaned;
}

/** Shrink a photo before sending it to the model: faster, cheaper, and plenty for understanding it. */
export async function imagePart(image: Buffer): Promise<Part> {
  const jpeg = await sharp(image).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } };
}

// --- memory -----------------------------------------------------------------------------------

async function recall(sessionId: string, chatJid: string, limit: number): Promise<Turn[]> {
  if (limit <= 0) return [];
  const rows = await prisma.aiMessage.findMany({
    where: { sessionId, chatJid, createdAt: { gte: new Date(Date.now() - HISTORY_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' },
    take: limit
  });
  const turns = rows.reverse().map(row => ({ role: row.role === 'model' ? ('model' as const) : ('user' as const), parts: [{ text: row.text }] }));
  // The API expects a conversation to open with the user.
  while (turns[0]?.role === 'model') turns.shift();
  return turns;
}

async function remember(sessionId: string, chatJid: string, entries: { role: 'user' | 'model'; text: string }[], keep: number): Promise<void> {
  if (keep <= 0) return;
  const now = Date.now();
  for (const [index, entry] of entries.entries()) {
    // Distinct timestamps keep the order stable on databases with coarse clocks.
    await prisma.aiMessage.create({ data: { sessionId, chatJid, role: entry.role, text: entry.text.slice(0, 8000), createdAt: new Date(now + index) } });
  }
  const extra = await prisma.aiMessage.findMany({ where: { sessionId, chatJid }, orderBy: { createdAt: 'desc' }, skip: keep, select: { id: true } });
  if (extra.length) await prisma.aiMessage.deleteMany({ where: { id: { in: extra.map(row => row.id) } } });
}

/** Forget one chat, or every chat when `chatJid` is omitted. */
export async function clearMemory(sessionId: string, chatJid?: string): Promise<number> {
  const { count } = await prisma.aiMessage.deleteMany({ where: { sessionId, ...(chatJid ? { chatJid } : {}) } });
  return count;
}

export async function purgeOldMemory(): Promise<void> {
  await prisma.aiMessage.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - HISTORY_KEEP_MS) } } });
}

// --- asking -----------------------------------------------------------------------------------

/** Model behind the most recent answer from `ask` (read by the dashboard's "Try it"). */
let lastAnswerModel = '';
export const answeredBy = () => lastAnswerModel;

export interface Question {
  chatJid: string;
  text: string;
  image?: Buffer;
  senderName?: string;
  /** Group name, when the chat is a group. */
  group?: string;
  /** Skip reading and writing memory (one-off tasks such as "summarise this"). */
  stateless?: boolean;
  /** Replaces the owner's persona for task commands. */
  instruction?: string;
}

/** Ask the model, with the chat's recent history as context, and remember the exchange. */
export async function ask(bot: BotSession, question: Question): Promise<string> {
  const key = await getApiKey();
  if (!key) throw new AiError('no-key', 'The AI assistant is not set up yet. The owner can add a Gemini API key in the dashboard.');
  const settings = getSettings().ai;

  const who = question.senderName?.trim() || 'someone';
  const context = [
    `Today is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`,
    bot.me?.name ? `The account owner is ${bot.me.name}.` : '',
    question.group ? `This is the group chat "${question.group}". Messages are prefixed with the sender's name.` : `This is a private chat with ${who}.`
  ]
    .filter(Boolean)
    .join(' ');
  const system = question.instruction ? `${question.instruction}\n\n${HOUSE_RULES}` : systemPrompt(context);

  const spoken = question.group ? `${who}: ${question.text}` : question.text;
  const parts: Part[] = [];
  if (question.image) parts.push(await imagePart(question.image));
  parts.push({ text: spoken || 'What is in this picture?' });

  const history = question.stateless ? [] : await recall(bot.id, question.chatJid, settings.historyMessages);
  try {
    const { text: raw, model } = await generate({ key, system, turns: [...history, { role: 'user', parts }] });
    const answer = toWhatsApp(raw);
    lastAnswerModel = model;
    status.lastReplyAt = Date.now();
    status.lastError = null;
    if (!question.stateless) {
      await remember(
        bot.id,
        question.chatJid,
        [
          { role: 'user', text: question.image ? `[sent a photo] ${spoken}`.trim() : spoken },
          { role: 'model', text: answer }
        ],
        settings.historyMessages
      );
    }
    return answer;
  } catch (error) {
    const message = error instanceof AiError ? error.message : 'Unexpected error while asking the AI.';
    status.lastError = { message, at: Date.now() };
    throw error;
  }
}

// --- automatic replies --------------------------------------------------------------------------

const inFlight = new Set<string>();
const recentReplies = new Map<string, number[]>();

function overLimit(chatJid: string): boolean {
  const now = Date.now();
  const times = (recentReplies.get(chatJid) ?? []).filter(time => now - time < 60_000);
  recentReplies.set(chatJid, times);
  if (recentReplies.size > 5000) for (const [chat, list] of recentReplies) if (list.every(time => now - time >= 60_000)) recentReplies.delete(chat);
  return times.length >= MAX_REPLIES_PER_MINUTE;
}

/**
 * Answer an ordinary (non-command) message with the assistant.
 * @returns true when a reply was sent
 */
export async function handleAssistant(bot: BotSession, msg: WAMessage): Promise<boolean> {
  const settings = getSettings().ai;
  const jid = msg.key.remoteJid;
  if (!settings.enabled || !jid || msg.key.fromMe || !(await getApiKey())) return false;

  const isGroup = Boolean(isJidGroup(jid));
  if (settings.scope !== 'all' && (settings.scope === 'groups') !== isGroup) return false;

  const content = contentOf(msg.message);
  const text = textOf(content).trim();
  const hasImage = Boolean(content?.imageMessage) && settings.images;
  if (!text && !hasImage) return false;

  if (isGroup && settings.groupTrigger === 'mention') {
    // In a group, only speak when spoken to: an @mention, or a reply to one of our messages.
    const context = contextInfoOf(content);
    const addressed = [...(context?.mentionedJid ?? []), context?.participant].filter((id): id is string => Boolean(id));
    let toMe = false;
    for (const id of addressed) toMe ||= await bot.isSelf(id);
    if (!toMe) return false;
  }
  if (inFlight.has(jid) || overLimit(jid)) return false;

  inFlight.add(jid);
  try {
    await bot.sock?.sendPresenceUpdate('composing', jid).catch(() => {});
    const image = hasImage ? await bot.download(msg).catch(() => undefined) : undefined;
    const group = isGroup ? ((await bot.groupMeta(jid))?.subject ?? 'a group') : undefined;
    // Strip the @mention of the bot itself so it does not read as part of the question.
    const question = text.replace(/@\d{5,}/g, '').trim();
    const answer = await ask(bot, { chatJid: jid, text: question, image, senderName: msg.pushName ?? undefined, group });
    await bot.send(jid, { text: answer }, isGroup ? { quoted: msg } : undefined);
    recentReplies.get(jid)?.push(Date.now());
    recordActivity(bot.id, 'ai', `AI replied to ${msg.pushName?.trim() || 'a contact'}${group ? ` in ${group}` : ''}`, {
      detail: (question || '[photo]').slice(0, 200),
      chat: jid
    });
    return true;
  } catch (error) {
    // Automatic replies fail quietly: the person never asked a bot anything.
    if (error instanceof AiError) log.warn(`could not answer: ${error.message}`);
    else log.error({ err: error }, 'assistant failed');
    return false;
  } finally {
    inFlight.delete(jid);
    await bot.sock?.sendPresenceUpdate('paused', jid).catch(() => {});
  }
}
