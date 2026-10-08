import { scoped } from '../logger.js';
import { AiError, getApiKey, synthesizeSpeech } from './ai.js';
import { ffmpeg } from './downloader.js';
import { toVoiceNote } from './media-tools.js';

// Text to speech. With a Gemini key the natural AI voices are used; without one
// (or when Google is busy) a basic voice from Google Translate keeps the command working.

const log = scoped('speech');

export class SpeechError extends Error {}

/** Longest text read with the AI voices, and with the basic voice. */
export const MAX_SPEECH_CHARS = 1500;
const MAX_BASIC_CHARS = 600;
/** The basic voice reads at most this much per request. */
const BASIC_CHUNK_CHARS = 180;

export interface Speech {
  audio: Buffer;
  mimetype: string;
  /** True when the audio is Opus in Ogg, which WhatsApp shows as a voice note. */
  voiceNote: boolean;
  engine: 'ai' | 'basic';
}

const SCRIPTS: [RegExp, string][] = [
  [/[඀-෿]/, 'si'],
  [/[஀-௿]/, 'ta'],
  [/[ऀ-ॿ]/, 'hi'],
  [/[ঀ-৿]/, 'bn'],
  [/[؀-ۿ]/, 'ar'],
  [/[぀-ヿ]/, 'ja'],
  [/[가-힯]/, 'ko'],
  [/[一-鿿]/, 'zh-CN'],
  [/[Ѐ-ӿ]/, 'ru'],
  [/[฀-๿]/, 'th']
];

/** Language of a text, judged by its script. The basic voice has to be told; the AI voices work it out. */
export function guessLanguage(text: string): string {
  return SCRIPTS.find(([pattern]) => pattern.test(text))?.[1] ?? 'en';
}

/** Split text into pieces the basic voice accepts, breaking at sentence ends or spaces where possible. */
export function chunkText(text: string, size = BASIC_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size + 1);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf(', '));
    const at = cut > size / 3 ? cut + 1 : window.lastIndexOf(' ') > size / 3 ? window.lastIndexOf(' ') : size;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** 16-bit PCM in a WAV container, for servers without ffmpeg. */
function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function basicVoice(text: string, language: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (const chunk of chunkText(text.slice(0, MAX_BASIC_CHARS))) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(language)}&q=${encodeURIComponent(chunk)}`;
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    } catch {
      throw new SpeechError('The voice service did not answer. Try again in a moment.');
    }
    if (!response.ok) throw new SpeechError('The voice service could not read that text.');
    parts.push(Buffer.from(await response.arrayBuffer()));
  }
  // MP3 is a stream of independent frames, so the pieces simply follow one another.
  return Buffer.concat(parts);
}

/**
 * Read text aloud.
 * @param voice one of the AI voices (ignored by the basic voice)
 */
export async function speak(text: string, voice?: string): Promise<Speech> {
  const canConvert = Boolean(await ffmpeg());
  if (await getApiKey()) {
    try {
      const { pcm, sampleRate } = await synthesizeSpeech(text.slice(0, MAX_SPEECH_CHARS), voice);
      if (!canConvert) return { audio: wav(pcm, sampleRate), mimetype: 'audio/wav', voiceNote: false, engine: 'ai' };
      const audio = await toVoiceNote(pcm, ['-f', 's16le', '-ar', String(sampleRate), '-ac', '1']);
      return { audio, mimetype: 'audio/ogg; codecs=opus', voiceNote: true, engine: 'ai' };
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      log.warn(`AI voice unavailable (${error.message}); using the basic voice`);
    }
  }
  const mp3 = await basicVoice(text, guessLanguage(text));
  if (!canConvert) return { audio: mp3, mimetype: 'audio/mpeg', voiceNote: false, engine: 'basic' };
  return { audio: await toVoiceNote(mp3), mimetype: 'audio/ogg; codecs=opus', voiceNote: true, engine: 'basic' };
}
