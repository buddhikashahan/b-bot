import { isJidGroup, type WAMessage } from '@whiskeysockets/baileys';
import sharp from 'sharp';
import { isSealed, seal, unseal } from '../auth/secret.js';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';
import { getInternal, getSettings, setInternal } from '../settings.js';
import { contentOf, contextInfoOf, textOf } from '../whatsapp/message-utils.js';
import type { BotSession } from '../whatsapp/session.js';
import { recordActivity } from './activity.js';
import { speak } from './speech.js';

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
/** Things the assistant may start for one message. */
const MAX_ACTIONS_PER_REPLY = 2;
/** Longer voice notes are left alone: they cost a lot to process and are rarely meant for a bot. */
const MAX_VOICE_SECONDS = 300;

export const DEFAULT_PROMPT =
  'You are a friendly, helpful assistant answering WhatsApp messages on behalf of the account owner. ' +
  'Be warm, natural and to the point, the way a person texts.';

/** Appended to every prompt, custom or not, because the output is shown in WhatsApp. */
const HOUSE_RULES = [
  'How to reply:',
  '- This is a WhatsApp chat. Answer in a few short sentences unless they ask for detail.',
  '- Write in the language the person writes in.',
  '- Format only with WhatsApp markup: *bold*, _italic_, ~strikethrough~, `code`, and lines starting with "- " for lists. Never use Markdown headings, tables or double asterisks.',
  '- Answer questions, translate, explain, summarise and help with writing yourself.',
  '- If you do not know something, say so instead of guessing.'
].join('\n');

/** Added when the person spoke instead of typing. The first line lets the chat memory keep what was said. */
const VOICE_RULES =
  'The person sent the attached voice message. Begin your reply with one line "HEARD: " followed by what they said, ' +
  'word for word in the language they spoke, then an empty line, then your answer.';
/** Added when the answer goes back as a voice note. */
const SPOKEN_RULES =
  'Your answer will be read aloud to them, so ignore the formatting rules above: write plain spoken sentences in the language they spoke, ' +
  'at most about 70 words, with no lists, emoji, symbols or markup.';

/**
 * Appended in the chat memory to a request the assistant carried out with a function. It sits in
 * the person's turn, not the assistant's: a model repeats the shape of its own earlier replies,
 * and a note there comes back as a typed-out "[ran the command...]" instead of a function call.
 */
const DONE_NOTE = '[system note: this was done and the result was sent to them]';
/** The note an earlier version left in the assistant's turns, which the model learned to parrot. */
const OLD_NOTE = /^\[ran the command:[^\n]*\]$/gim;

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
  candidates?: { content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown> } }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/** A function the model may call (a Gemini function declaration). */
export interface AssistantTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A function call the model made. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface Answer {
  text: string;
  calls: ToolCall[];
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
async function generateWith(options: {
  key: string;
  model: string;
  system: string;
  turns: Turn[];
  tools?: AssistantTool[];
  timeoutMs: number;
  cancel?: AbortSignal;
}): Promise<Answer> {
  const path = `/models/${encodeURIComponent(options.model)}:generateContent`;
  const request = (thinking: boolean) =>
    call<GenerateResponse>(
      path,
      options.key,
      {
        systemInstruction: { parts: [{ text: options.system }] },
        contents: options.turns,
        ...(options.tools?.length ? { tools: [{ functionDeclarations: options.tools }] } : {}),
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
  const parts = candidate?.content?.parts ?? [];
  // Newer models interleave their reasoning as "thought" parts; only the answer is for the chat.
  const text = parts
    .filter(part => !part.thought && part.text)
    .map(part => part.text)
    .join('')
    .trim();
  const calls = parts.filter(part => part.functionCall?.name).map(part => ({ name: part.functionCall!.name!, args: part.functionCall!.args ?? {} }));
  if (text || calls.length) return { text, calls };
  if (data.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY' || candidate?.finishReason === 'PROHIBITED_CONTENT') {
    throw new AiError('blocked', "The AI declined to answer that because of Google's safety filters.");
  }
  if (candidate?.finishReason === 'MALFORMED_FUNCTION_CALL') {
    throw new AiError('other', 'The AI tried to do that but got it wrong. Try saying it another way.');
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

type Outcome = ({ model: string } & Answer) | { model: string; error: unknown };

/**
 * Ask the chosen model, with the backup model as a safety net. Newer models are
 * frequently at capacity at Google (HTTP 503, or no answer at all), and a chat
 * reply that arrives a little less clever beats one that never arrives.
 *
 * The main model gets a short head start. If it has not answered by then, the
 * backup is asked as well and whichever answers first wins; the other request
 * is cancelled. A model that failed is tried last for the next few minutes.
 */
export async function generate(options: { key: string; system: string; turns: Turn[]; tools?: AssistantTool[] }): Promise<{ model: string } & Answer> {
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
      answer => ({ model, ...answer }),
      error => ({ model, error })
    );
  const succeed = (outcome: { model: string } & Answer) => {
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

// --- speech -----------------------------------------------------------------------------------

interface SpeechResponse {
  candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
}

/** Used when the key's model list cannot be read. */
const KNOWN_SPEECH_MODELS = ['gemini-2.5-flash-preview-tts'];
const SPEECH_MODELS_TTL_MS = 6 * 60 * 60 * 1000;
const SPEECH_TIMEOUT_MS = 60_000;
let speechModels: { ids: string[]; at: number } | undefined;

/** Voices offered by Gemini's speech models. */
export const VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr'] as const;

/** Text-to-speech models this key can use: the fast ones first, newest first. */
async function listSpeechModels(key: string): Promise<string[]> {
  if (speechModels && Date.now() - speechModels.at < SPEECH_MODELS_TTL_MS) return speechModels.ids;
  let ids = KNOWN_SPEECH_MODELS;
  try {
    const data = await call<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>('/models?pageSize=200', key, undefined, LIST_TIMEOUT_MS);
    const found = (data.models ?? [])
      .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
      .map(model => model.name.replace(/^models\//, ''))
      .filter(id => id.startsWith('gemini') && id.includes('tts'))
      .sort((a, b) => Number(b.includes('flash')) - Number(a.includes('flash')) || b.localeCompare(a, 'en', { numeric: true }));
    if (found.length) ids = found;
  } catch {
    // Keep the known model: the request itself will report what is wrong.
  }
  speechModels = { ids, at: Date.now() };
  return ids;
}

export interface SynthesizedSpeech {
  audio: Buffer;
  mimeType: string;
  /**
   * Set when `audio` is bare 16-bit samples with no header. Otherwise it is a complete audio
   * file that describes itself.
   */
  raw?: { sampleRate: number; channels: number };
}

/** Does this audio start like a file (WAV, Ogg, FLAC, tagged MP3) rather than like bare samples? */
function isAudioFile(audio: Buffer): boolean {
  const magic = audio.subarray(0, 4).toString('latin1');
  return magic === 'RIFF' || magic === 'OggS' || magic === 'fLaC' || magic.startsWith('ID3');
}

/**
 * What a speech model answered with. The models differ: the 2.5 and 3.1 ones send bare
 * samples ("audio/L16;codec=pcm;rate=24000"), the 3.8 ones a WAV file with a block of
 * content-credential data after the sound. Read as bare samples, that file's header and
 * trailing block become a click at the start and a burst of loud noise at the end.
 */
export function describeSpeech(audio: Buffer, mimeType = ''): SynthesizedSpeech {
  if (isAudioFile(audio) || (mimeType && !/^audio\/(l16|pcm)\b/i.test(mimeType))) {
    return { audio, mimeType: mimeType && !/l16|pcm/i.test(mimeType) ? mimeType.split(';')[0].trim() : 'audio/wav' };
  }
  return {
    audio,
    mimeType: 'audio/L16',
    raw: { sampleRate: Number(/rate=(\d+)/i.exec(mimeType)?.[1]) || 24_000, channels: Number(/channels=(\d+)/i.exec(mimeType)?.[1]) || 1 }
  };
}

/**
 * Turn text into speech with Gemini.
 * @returns the audio as the model sent it: bare samples or a complete file (see `raw`)
 * @throws AiError when no key is saved or no speech model answers
 */
export async function synthesizeSpeech(text: string, voice: string = VOICES[0]): Promise<SynthesizedSpeech> {
  const key = await getApiKey();
  if (!key) throw new AiError('no-key', 'The AI assistant is not set up yet. The owner can add a Gemini API key in the dashboard.');
  let failure: unknown = new AiError('other', 'No speech model is available for this key.');
  for (const model of (await listSpeechModels(key)).slice(0, 2)) {
    try {
      const data = await call<SpeechResponse>(
        `/models/${encodeURIComponent(model)}:generateContent`,
        key,
        {
          contents: [{ parts: [{ text }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
        },
        TIMEOUT_OVERRIDE_MS ?? SPEECH_TIMEOUT_MS
      );
      const audio = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData;
      if (audio?.data) return describeSpeech(Buffer.from(audio.data, 'base64'), audio.mimeType);
      failure = new AiError('other', 'The AI returned no audio for that text.');
    } catch (error) {
      failure = error;
      // Another model cannot fix a rejected key or a missing connection.
      if (error instanceof AiError && (error.kind === 'bad-key' || error.kind === 'network')) break;
    }
  }
  throw failure;
}

// --- prompt and formatting ----------------------------------------------------------------------

export function systemPrompt(context: string): string {
  const persona = getSettings().ai.prompt.trim() || DEFAULT_PROMPT;
  return `${persona}\n\n${context}\n\n${HOUSE_RULES}`;
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
  const turns: { role: 'user' | 'model'; text: string }[] = [];
  for (const row of rows.reverse()) {
    const role = row.role === 'model' ? ('model' as const) : ('user' as const);
    let text = row.text;
    const last = turns.at(-1);
    if (role === 'model' && OLD_NOTE.test(text)) {
      // Memory written by an earlier version: move its note to where notes live now.
      text = text.replace(OLD_NOTE, '').trim();
      if (last?.role === 'user' && !last.text.endsWith(DONE_NOTE)) last.text += `\n${DONE_NOTE}`;
    }
    OLD_NOTE.lastIndex = 0;
    if (!text) continue;
    // A request answered with a file leaves no assistant turn, so two of the person's can meet: join them.
    if (last?.role === role) last.text += `\n${text}`;
    else turns.push({ role, text });
  }
  // The API expects a conversation to open with the user.
  while (turns[0]?.role === 'model') turns.shift();
  return turns.map(turn => ({ role: turn.role, parts: [{ text: turn.text }] }));
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
  /** A voice note to listen to, as WhatsApp delivers it (Opus in Ogg). */
  voice?: Buffer;
  /** The answer will be read aloud: ask for plain spoken sentences and skip WhatsApp formatting. */
  spoken?: boolean;
  senderName?: string;
  /** Group name, when the chat is a group. */
  group?: string;
  /** Skip reading and writing memory (one-off tasks such as "summarise this"). */
  stateless?: boolean;
  /** Replaces the owner's persona for task commands. */
  instruction?: string;
  /**
   * The message being answered. With it (and the setting on) the assistant may act for its
   * sender, e.g. download a song; without it there is nobody to act for.
   */
  msg?: WAMessage;
}

/**
 * What the assistant can do besides talk. Supplied at start-up by the command registry, which
 * knows the commands and already imports this module, so the dependency points one way.
 */
export interface AssistantTools {
  /**
   * The functions the sender of `msg` may use here and now, and how to use them (added to the
   * system prompt). No tools when they may not use any.
   */
  available(bot: BotSession, msg: WAMessage): Promise<{ tools: AssistantTool[]; guidance: string }>;
  /** Carry out one call for the sender of `msg`. The result goes to the chat. */
  run(bot: BotSession, msg: WAMessage, call: ToolCall): Promise<void>;
}
let assistantTools: AssistantTools | undefined;
export function provideAssistantTools(tools: AssistantTools): void {
  assistantTools = tools;
}

/** Carry out what the assistant decided to do (see `converse`). Each action answers in the chat by itself. */
export async function runActions(bot: BotSession, msg: WAMessage, actions: ToolCall[]): Promise<void> {
  for (const action of actions) {
    try {
      await assistantTools?.run(bot, msg, action);
    } catch (err) {
      log.error({ err }, `the assistant could not carry out ${action.name}`);
    }
  }
}

/** Ask the model, with the chat's recent history as context, and remember the exchange. */
export async function ask(bot: BotSession, question: Question): Promise<string> {
  return (await converse(bot, question)).answer;
}

/** Split a reply to a voice note into what the model heard and what it answers. */
export function splitHeard(raw: string): { heard?: string; answer: string } {
  const match = /^\s*HEARD:[ \t]*(.*)\n+([\s\S]+)$/i.exec(raw);
  if (match) return { heard: match[1].trim() || undefined, answer: match[2].trim() };
  return { answer: raw.replace(/^\s*HEARD:.*$/im, '').trim() || raw.trim() };
}

/** Text fit for a text-to-speech voice: no markup, no emoji. */
export function toSpeech(text: string): string {
  return text
    .replace(/[*_~`#>]/g, '')
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * `ask`, also returning what the model heard when the question was a voice note, and what it
 * decided to do rather than say (see `runActions`). When there are actions there is no answer
 * text: the file that arrives is the reply.
 */
export async function converse(bot: BotSession, question: Question): Promise<{ answer: string; heard?: string; actions: ToolCall[] }> {
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
  // Acting is for conversation, not for the one-off tasks (summarise, translate...) that set their own instruction.
  const offered =
    settings.downloads && question.msg && assistantTools && !question.instruction ? await assistantTools.available(bot, question.msg) : { tools: [], guidance: '' };
  const system = [
    question.instruction ? `${question.instruction}\n\n${HOUSE_RULES}` : systemPrompt(context),
    offered.tools.length ? offered.guidance : '',
    question.voice ? VOICE_RULES : '',
    question.spoken ? SPOKEN_RULES : ''
  ]
    .filter(Boolean)
    .join('\n\n');

  const typed = question.text || (question.voice ? '(voice message)' : '');
  const spoken = question.group ? `${who}: ${typed}` : typed;
  const parts: Part[] = [];
  if (question.image) parts.push(await imagePart(question.image));
  if (question.voice) parts.push({ inlineData: { mimeType: 'audio/ogg', data: question.voice.toString('base64') } });
  parts.push({ text: spoken || 'What is in this picture?' });

  const history = question.stateless ? [] : await recall(bot.id, question.chatJid, settings.historyMessages);
  // After a request that was answered with a file the memory ends on the person's turn: this message continues it.
  const open = history.at(-1)?.role === 'user' ? history.pop() : undefined;
  const turns: Turn[] = [...history, { role: 'user', parts: [...(open?.parts ?? []), ...parts] }];
  try {
    const { text: raw, model, calls } = await generate({ key, system, turns, tools: offered.tools });
    // Only what was offered, and not a flood of it.
    const actions = calls.filter(item => offered.tools.some(tool => tool.name === item.name)).slice(0, MAX_ACTIONS_PER_REPLY);
    // A stray system note is never something to say; nor is anything else once the model has acted.
    const reply = question.voice ? splitHeard(raw) : { answer: raw, heard: undefined };
    const words = actions.length ? '' : reply.answer.replace(OLD_NOTE, '').replaceAll(DONE_NOTE, '').trim();
    const answer = question.spoken ? toSpeech(words) : toWhatsApp(words);
    // The model wrote nothing a person should read and did nothing either.
    if (!answer && !actions.length) throw new AiError('other', 'The AI returned an empty answer. Try rephrasing.');
    lastAnswerModel = model;
    status.lastReplyAt = Date.now();
    status.lastError = null;
    if (!question.stateless) {
      const said = question.voice ? `[voice message] ${reply.heard ?? ''}`.trim() : question.image ? `[sent a photo] ${spoken}`.trim() : spoken;
      await remember(
        bot.id,
        question.chatJid,
        actions.length
          ? [{ role: 'user', text: `${question.group && question.voice ? `${who}: ${said}` : said}\n${DONE_NOTE}` }]
          : [
              { role: 'user', text: question.group && question.voice ? `${who}: ${said}` : said },
              { role: 'model', text: answer }
            ],
        settings.historyMessages
      );
    }
    return { answer, heard: reply.heard, actions };
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
  // Voice notes only: a forwarded song is not somebody talking to us.
  const voiceNote = settings.voiceNotes && content?.audioMessage?.ptt ? content.audioMessage : undefined;
  if (voiceNote && Number(voiceNote.seconds ?? 0) > MAX_VOICE_SECONDS) return false;
  if (!text && !hasImage && !voiceNote) return false;

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
    const aloud = Boolean(voiceNote) && settings.voiceReplies;
    await bot.sock?.sendPresenceUpdate(aloud ? 'recording' : 'composing', jid).catch(() => {});
    const media = hasImage || voiceNote ? await bot.download(msg).catch(() => undefined) : undefined;
    // A voice note that cannot be fetched leaves nothing to answer.
    if (voiceNote && !media) return false;
    const group = isGroup ? ((await bot.groupMeta(jid))?.subject ?? 'a group') : undefined;
    // Strip the @mention of the bot itself so it does not read as part of the question.
    const question = text.replace(/@\d{5,}/g, '').trim();
    const { answer, heard, actions } = await converse(bot, {
      chatJid: jid,
      text: question,
      image: hasImage ? media : undefined,
      voice: voiceNote ? media : undefined,
      spoken: aloud,
      senderName: msg.pushName ?? undefined,
      group,
      msg
    });
    const options = isGroup ? { quoted: msg } : undefined;
    // Spoken when they spoke; if the voice cannot be produced the words still arrive as text.
    const speech = aloud && answer ? await speak(answer, settings.voice).catch(err => void log.warn(`could not speak the answer: ${err instanceof Error ? err.message : err}`)) : undefined;
    if (speech) await bot.send(jid, { audio: speech.audio, mimetype: speech.mimetype, ptt: speech.voiceNote }, options);
    else if (answer) await bot.send(jid, { text: answer }, options);
    // Not awaited: a download can take a minute, and the chat should not wait for it to be answered again.
    if (actions.length) void runActions(bot, msg, actions);
    recentReplies.get(jid)?.push(Date.now());
    const what = voiceNote ? (speech ? 'AI answered a voice note from' : 'AI replied to a voice note from') : 'AI replied to';
    recordActivity(bot.id, 'ai', `${what} ${msg.pushName?.trim() || 'a contact'}${group ? ` in ${group}` : ''}`, {
      detail: (voiceNote ? (heard ?? '[voice note]') : question || '[photo]').slice(0, 200),
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
