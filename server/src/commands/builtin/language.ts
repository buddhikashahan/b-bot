import { AiError, ask, getApiKey, VOICES } from '../../features/ai.js';
import { MediaError } from '../../features/media-tools.js';
import { MAX_SPEECH_CHARS, speak, SpeechError } from '../../features/speech.js';
import { card, code, fail, field, note, quote, usage } from '../../whatsapp/format.js';
import type { Command } from '../types.js';
import { getJson, lookup, LookupError } from './info.js';

// Speaking and translating.

const LANGUAGES: Record<string, string> = {
  en: 'English',
  si: 'Sinhala',
  ta: 'Tamil',
  hi: 'Hindi',
  ar: 'Arabic',
  bn: 'Bengali',
  ur: 'Urdu',
  ml: 'Malayalam',
  te: 'Telugu',
  kn: 'Kannada',
  mr: 'Marathi',
  gu: 'Gujarati',
  pa: 'Punjabi',
  ne: 'Nepali',
  fr: 'French',
  es: 'Spanish',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  sv: 'Swedish',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  el: 'Greek',
  tr: 'Turkish',
  he: 'Hebrew',
  fa: 'Persian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ms: 'Malay',
  fil: 'Filipino',
  sw: 'Swahili'
};

/** A language given as a code ("si") or a name ("sinhala"). */
export function findLanguage(word: string | undefined): { code: string; name: string } | undefined {
  const wanted = word?.trim().toLowerCase();
  if (!wanted) return undefined;
  if (LANGUAGES[wanted]) return { code: wanted, name: LANGUAGES[wanted] };
  const entry = Object.entries(LANGUAGES).find(([, name]) => name.toLowerCase() === wanted);
  return entry ? { code: entry[0], name: entry[1] } : undefined;
}

/** Translation without an AI key: a free service, good for short text. */
async function basicTranslate(text: string, target: string): Promise<string> {
  if (text.length > 450) throw new LookupError('That is too long to translate in one go without the AI assistant (450 characters at most).');
  type Translation = { responseData: { translatedText: string }; responseStatus: number | string };
  const result = await getJson<Translation>(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`autodetect|${target}`)}`
  );
  if (Number(result.responseStatus) !== 200) throw new LookupError('I could not translate that. Try a shorter text or another language.');
  return result.responseData.translatedText;
}

export const languageCommands: Command[] = [
  {
    name: 'tts',
    aliases: ['say', 'speak', 'voice'],
    category: 'utility',
    description: 'Read text aloud as a voice note (type it, or reply to a message).',
    usage: 'tts [voice] <text>',
    cooldown: 10,
    async execute(ctx) {
      const [first = '', ...rest] = ctx.args;
      const voice = VOICES.find(name => name.toLowerCase() === first.toLowerCase());
      const text = ((voice ? rest.join(' ') : ctx.text).trim() || ctx.quoted?.text.trim() || '').replace(/[*_~`]/g, '');
      if (!text) {
        await ctx.reply(
          `${usage(ctx.prefix, 'tts [voice] <text>', 'tts Good morning everyone')}\n${note(`Or reply to a message with ${ctx.prefix}tts. Voices: ${VOICES.join(', ')}.`)}`
        );
        return;
      }
      if (text.length > MAX_SPEECH_CHARS) {
        await ctx.reply(fail('That is too long to read aloud', `Keep it under ${MAX_SPEECH_CHARS} characters.`));
        return;
      }
      await ctx.react('🎙️');
      await ctx.sock.sendPresenceUpdate('recording', ctx.jid).catch(() => {});
      try {
        const speech = await speak(text, voice ?? ctx.settings.ai.voice);
        if (speech.voiceNote) await ctx.reply({ audio: speech.audio, mimetype: speech.mimetype, ptt: true });
        else if (speech.mimetype === 'audio/wav') await ctx.reply({ document: speech.audio, mimetype: speech.mimetype, fileName: 'speech.wav' });
        else await ctx.reply({ audio: speech.audio, mimetype: speech.mimetype });
        await ctx.react('✅');
      } catch (error) {
        if (!(error instanceof SpeechError) && !(error instanceof MediaError)) throw error;
        await ctx.react('❌');
        await ctx.reply(fail('Could not read that aloud', error.message));
      } finally {
        await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {});
      }
    }
  },
  {
    name: 'translate',
    aliases: ['tr', 'trt'],
    category: 'utility',
    description: 'Translate text, or the message you reply to, into another language.',
    usage: 'translate <language> <text>',
    cooldown: 5,
    execute: lookup(async ctx => {
      // The language may be left out: "translate bonjour", or a bare reply, means "into English".
      const named = findLanguage(ctx.args[0]);
      const target = named ?? { code: 'en', name: 'English' };
      const text = (named ? ctx.args.slice(1).join(' ') : ctx.text).trim() || ctx.quoted?.text.trim() || '';
      if (!text) {
        await ctx.reply(
          `${usage(ctx.prefix, 'translate <language> <text>', 'translate sinhala Good morning')}\n${note(
            `Use a language name or code (${code('si')}, ${code('ta')}, ${code('hi')}, ${code('fr')}, ${code('ja')}...). Reply to a message with ${ctx.prefix}translate to get it in English.`
          )}`
        );
        return;
      }
      if (text.length > 3000) throw new LookupError('That is too long to translate in one go (3000 characters at most).');

      let translation: string | undefined;
      if (await getApiKey()) {
        await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
        try {
          translation = await ask(ctx.bot, {
            chatJid: ctx.jid,
            text,
            stateless: true,
            instruction: `You are a translator. Translate the message you are given into ${target.name}. Output only the translation: no notes, no quotation marks, no transliteration.`
          });
        } catch (error) {
          // The free service below still works when the AI is busy.
          if (!(error instanceof AiError)) throw error;
        } finally {
          await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {});
        }
      }
      translation ??= await basicTranslate(text, target.code);
      await ctx.reply([card('🌐', 'Translation', [field('To', target.name)]), '', quote(translation)].join('\n'));
    })
  }
];
