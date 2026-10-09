import type { WAMessage } from '@whiskeysockets/baileys';
import type { AssistantTool, AssistantTools, ToolCall } from '../features/ai.js';
import { SITES, findUrl, parseMediaUrl, type Site } from '../features/downloader.js';
import { getSettings } from '../settings.js';
import { fail } from '../whatsapp/format.js';
import type { BotSession } from '../whatsapp/session.js';

// What the AI assistant can do besides talk: send people songs and videos.
//
// The model gets two functions, download_audio and download_video. A call is turned into the
// download command a person would type (`yta mp3 lelena`, `tiktok <link>`) and run as theirs, so
// every rule that applies to the command (who may download, size limits, cooldowns) applies here.
// Only commands that deliver a file straight away are used: nothing that answers with a menu.

const AUDIO = 'download_audio';
const VIDEO = 'download_video';

/** The command that downloads a link from each site. YouTube is handled by `yta` / `ytv`. */
const SITE_COMMAND: Record<Exclude<Site, 'youtube'>, string> = {
  facebook: 'fb',
  tiktok: 'tiktok',
  instagram: 'insta',
  twitter: 'x',
  pinterest: 'pin',
  threads: 'threads',
  snapchat: 'snap',
  reddit: 'reddit',
  soundcloud: 'soundcloud',
  vimeo: 'vimeo',
  dailymotion: 'dailymotion',
  twitch: 'twitch',
  bilibili: 'bilibili',
  likee: 'likee'
};
const SITE_NAME: Partial<Record<Site, string>> = { facebook: 'Facebook', tiktok: 'TikTok', instagram: 'Instagram', twitter: 'X', soundcloud: 'SoundCloud' };
/** Commands that have current information the model does not. */
const LIVE_INFO = ['weather', 'news', 'worldnews', 'crypto'];

const QUERY = {
  type: 'string',
  description: 'The name to search for, as they said it (keep the artist if they named one), or the link they sent, copied exactly.'
};
const TOOLS: Record<string, AssistantTool> = {
  [AUDIO]: {
    name: AUDIO,
    description: 'Find a song, or take the sound of a video, and send it to the chat as audio. For any request for a song, music, audio or an MP3.',
    parameters: {
      type: 'object',
      properties: {
        query: QUERY,
        format: {
          type: 'string',
          enum: ['audio', 'mp3', 'voice', 'file'],
          description: 'audio: plays in the chat (the default). mp3: when they say MP3. voice: as a voice note. file: as a document.'
        }
      },
      required: ['query']
    }
  },
  [VIDEO]: {
    name: VIDEO,
    description: 'Find a video, or take the one behind a link, and send it to the chat. For any request for a video or clip, and for links to videos.',
    parameters: {
      type: 'object',
      properties: {
        query: QUERY,
        quality: { type: 'string', enum: ['360', '480', '720', '1080'], description: 'Only when they name a quality.' },
        as_file: { type: 'boolean', description: 'True when they ask for it as a document or file.' }
      },
      required: ['query']
    }
  }
};

function siteOf(url: string): Site | undefined {
  return (Object.keys(SITES) as Site[]).find(site => parseMediaUrl(url, [site]));
}

/**
 * The command line that carries out a call, e.g. "yta mp3 lelena".
 * @returns the line, or a sentence for the person when the call cannot be carried out
 */
export function commandFor(call: ToolCall): { line: string } | { problem: string } {
  const audio = call.name === AUDIO;
  const query = String(call.args.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!query) return { problem: 'Tell me the name of the song or video, or send its link.' };
  const format = String(call.args.format ?? 'audio');
  const asFile = audio ? format === 'file' : call.args.as_file === true;

  const link = findUrl(query);
  const site = link ? siteOf(link) : undefined;
  if (link && !site) return { problem: 'I cannot download from that site.' };
  if (link && site && site !== 'youtube') {
    return { line: [SITE_COMMAND[site], link, audio ? 'audio' : 'video', asFile ? 'doc' : ''].filter(Boolean).join(' ') };
  }
  // YouTube, by link or by name. The option always comes first, so a name may contain words like "mp3" or "720".
  const target = link ?? query;
  if (audio) return { line: `yta ${{ mp3: 'mp3', voice: 'voice', file: 'doc' }[format] ?? 'std'} ${target}` };
  const quality = ['360', '480', '720', '1080'].includes(String(call.args.quality)) ? String(call.args.quality) : '480';
  return { line: `ytv ${asFile ? 'doc' : quality} ${target}` };
}

/** How the model is told to use the functions. Short on purpose: every word here is sent with every message. */
function guidance(names: Set<string>, prefix: string): string {
  const sites = ['YouTube', ...(Object.keys(SITE_COMMAND) as Site[]).filter(site => names.has(SITE_COMMAND[site as Exclude<Site, 'youtube'>]) && SITE_NAME[site]).map(site => SITE_NAME[site])];
  const live = LIVE_INFO.filter(name => names.has(name)).map(name => `${prefix}${name}`);
  return [
    'Sending songs and videos:',
    `- When they ask for a song, music, audio or an MP3, call ${AUDIO} at once. When they ask for a video or clip, call ${VIDEO}.`,
    `- When a message has a link to a video or post (${sites.join(', ')} and similar), call ${VIDEO} with the link, or ${AUDIO} if they want only the sound. A message that is nothing but such a link is a request to download it.`,
    '- Never ask which format or quality they want and never offer choices: use the defaults unless they named one.',
    '- When you call a function, write nothing else: the file that arrives is the reply. Never say you are downloading or have sent something without calling a function in that same reply, and never write a function call out as text.',
    '- Talking about a song or video (who sings it, what it means) is not a request to download it: just answer.',
    names.has('yts') ? `- Asked only to search or to list results, do not download: say they can send ${prefix}yts followed by the words.` : '',
    '- A "[system note: ...]" line in an earlier message says that request was already carried out. Do not repeat it unless asked, and never write such a line yourself.',
    live.length
      ? `- You have no live data. Asked for today's weather, news or prices, say so in one sentence and name the command that has it: ${live.join(', ')}.`
      : "- You have no live data: asked for today's weather, news or prices, say so."
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the assistant's tools on top of the command registry.
 * @param commandNames the commands the sender of a message could type themselves, here and now
 * @param runCommand run a command line as if the sender had typed it; false when it did not run
 */
export function downloadTools(
  commandNames: (bot: BotSession, msg: WAMessage) => Promise<string[]>,
  runCommand: (bot: BotSession, msg: WAMessage, line: string) => Promise<boolean>
): AssistantTools {
  return {
    async available(bot, msg) {
      const names = new Set(await commandNames(bot, msg));
      const tools = [names.has('yta') ? TOOLS[AUDIO] : undefined, names.has('ytv') ? TOOLS[VIDEO] : undefined].filter((tool): tool is AssistantTool => Boolean(tool));
      return { tools, guidance: guidance(names, getSettings().commands.prefix) };
    },
    async run(bot, msg, call) {
      const jid = msg.key.remoteJid;
      if (!jid) return;
      const command = commandFor(call);
      if ('line' in command && (await runCommand(bot, msg, command.line))) return;
      await bot.send(jid, { text: fail('line' in command ? 'That download is not available here' : command.problem) }, { quoted: msg });
    }
  };
}
