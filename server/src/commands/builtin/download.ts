import { recordActivity } from '../../features/activity.js';
import { remoteThumbnail } from '../../features/branding.js';
import {
  DownloadError,
  downloadMedia,
  findUrl,
  installYtDlp,
  lookupMedia,
  parseMediaUrl,
  searchYouTube,
  type AudioQuality,
  type MediaInfo,
  type MediaKind,
  type Site
} from '../../features/downloader.js';
import { MediaError, toVoiceNote } from '../../features/media-tools.js';
import { sendMenu, type MenuOption } from '../../features/menus.js';
import { bold, card, clock, compact, fail, field, fileSize, italic, note, quote, usage } from '../../whatsapp/format.js';
import type { Command, CommandContext } from '../types.js';

const SITE_LABEL: Record<Site, string> = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  twitter: 'X (Twitter)',
  pinterest: 'Pinterest',
  soundcloud: 'SoundCloud',
  reddit: 'Reddit',
  vimeo: 'Vimeo',
  dailymotion: 'Dailymotion',
  twitch: 'Twitch',
  threads: 'Threads',
  snapchat: 'Snapchat',
  bilibili: 'Bilibili',
  likee: 'Likee'
};

/** What to fetch and how to hand it over. */
interface Delivery {
  kind: MediaKind;
  audio?: AudioQuality;
  maxHeight?: number;
  /** Send as a file attachment instead of playable media. */
  asDocument?: boolean;
  /** Send audio as a voice note. */
  voice?: boolean;
  /** Post the details card (with thumbnail) before the file: for commands with no earlier preview. */
  announce?: boolean;
}

/** Check the feature switches; replies and returns false when the caller may not download. */
async function allowed(ctx: CommandContext): Promise<boolean> {
  const { downloads } = ctx.settings;
  if (!downloads.enabled) {
    await ctx.reply(fail('Downloads are switched off', 'The owner can turn them on in the dashboard.'));
    return false;
  }
  if (downloads.ownerOnly && !ctx.isOwner) {
    await ctx.reply(`🔒 ${bold('Owner command')}\n${quote('Downloads are limited to the bot owner.')}`);
    return false;
  }
  return true;
}

function infoRows(info: MediaInfo, sizeBytes?: number): string[] {
  return [
    `🎬 ${bold(info.title.slice(0, 120))}`,
    info.uploader ? `👤 ${field('By', info.uploader)}` : '',
    info.durationSeconds ? `⏱️ ${field('Length', clock(info.durationSeconds))}` : '',
    info.views ? `👁️ ${field('Views', compact(info.views))}` : '',
    sizeBytes ? `📦 ${field('Size', fileSize(sizeBytes))}` : ''
  ].filter(Boolean);
}

/** Run a download step and turn expected failures into a reply. Returns undefined when it failed. */
async function attempt<T>(ctx: CommandContext, title: string, work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof DownloadError) && !(error instanceof MediaError)) throw error;
    await ctx.react('❌');
    await ctx.reply(fail(title, error.message));
    return undefined;
  }
}

/** Download `url` and deliver it to the chat, with reactions as a progress indicator. */
async function deliver(ctx: CommandContext, url: string, delivery: Delivery, icon: string, heading: string): Promise<void> {
  const { maxSizeMb, maxMinutes } = ctx.settings.downloads;
  await ctx.react('⏳');
  const media = await attempt(ctx, 'Download failed', () =>
    downloadMedia(url, delivery.kind, { maxSizeMb, maxMinutes }, { audio: delivery.audio, maxHeight: delivery.maxHeight })
  );
  if (!media) return;

  try {
    const { info } = media;
    const caption = card(icon, heading, infoRows(info, media.sizeBytes));
    const source = { url: media.file };
    const fileName = `${info.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'download'}.${media.extension}`;

    // Audio has no caption, so its details go out first, on the thumbnail. The audio itself is
    // sent bare: WhatsApp silently drops audio that carries a link-preview card.
    if (delivery.announce && delivery.kind === 'audio') {
      const poster = await remoteThumbnail(info.thumbnail, 480);
      await ctx.reply(poster ? { image: poster, caption } : caption);
    }

    // Very large videos, and containers WhatsApp cannot play, go out as files.
    const asDocument = delivery.asDocument || !media.playable || (delivery.kind === 'video' && media.sizeBytes > 64 * 1024 * 1024);
    if (delivery.voice) {
      const voice = await attempt(ctx, 'Could not make a voice note', () => toVoiceNote({ file: media.file }));
      if (!voice) return;
      await ctx.reply({ audio: voice, mimetype: 'audio/ogg; codecs=opus', ptt: true });
    } else if (asDocument) {
      await ctx.reply({ document: source, mimetype: media.mimetype, fileName, caption });
    } else if (delivery.kind === 'audio') {
      await ctx.reply({ audio: source, mimetype: media.mimetype, fileName });
    } else {
      await ctx.reply({ video: source, mimetype: media.mimetype, caption });
    }
    await ctx.react('✅');
    recordActivity(ctx.bot.id, 'command', `Downloaded ${delivery.kind === 'audio' ? 'audio' : 'a video'}: ${info.title.slice(0, 80)}`, {
      detail: `${fileSize(media.sizeBytes)} for ${ctx.senderName || ctx.sender}`,
      chat: ctx.jid
    });
  } finally {
    await media.cleanup().catch(() => {});
  }
}

/** A link in the message or the quoted message, checked against the allowed sites. */
function linkFrom(ctx: CommandContext, sites?: Site[]): string | undefined {
  const raw = findUrl(ctx.text) ?? findUrl(ctx.quoted?.text ?? '');
  return raw ? parseMediaUrl(raw, sites) : undefined;
}

/** Is `word` one of the option words typed with the command (links aside)? */
function hasWord(ctx: CommandContext, word: string): boolean {
  return ctx.text
    .replace(/https?:\/\/\S+/gi, ' ')
    .toLowerCase()
    .split(/\s+/)
    .includes(word);
}

/** Resolve "a YouTube link, or words to search for" to one video, with its details. */
async function findYouTube(ctx: CommandContext, example: string): Promise<MediaInfo | undefined> {
  const raw = findUrl(ctx.text) ?? (ctx.text.trim() ? undefined : findUrl(ctx.quoted?.text ?? ''));
  if (raw) {
    const url = parseMediaUrl(raw, ['youtube']);
    if (!url) {
      await ctx.reply(fail('That is not a YouTube link', `For other sites use ${ctx.prefix}fb, ${ctx.prefix}tiktok, ${ctx.prefix}insta or ${ctx.prefix}x.`));
      return undefined;
    }
    await ctx.react('🔎');
    return attempt(ctx, 'Could not open that video', () => lookupMedia(url));
  }
  const query = ctx.text.trim();
  if (!query) {
    await ctx.reply(usage(ctx.prefix, `${ctx.command} <name or link>`, example));
    return undefined;
  }
  await ctx.react('🔎');
  const results = await attempt(ctx, 'Search failed', () => searchYouTube(query, 1));
  if (!results) return undefined;
  if (results.length === 0) {
    await ctx.reply(fail('Nothing found', `No YouTube result for "${query}".`));
    return undefined;
  }
  return results[0];
}

// `button` is what the option says when menus are sent as tappable buttons.
const choice = (button: string, hint: string, text: string): MenuOption => {
  const [icon, ...words] = button.split(' ');
  return { label: `${icon} ${bold(words.join(' '))}${hint ? ` ${italic(hint)}` : ''}`, button, action: { type: 'command', text } };
};
/**
 * The YouTube video a format command is about: a link (also in the replied-to message), or
 * otherwise the best match for the words typed after the options.
 * @param options the option words of the command ("mp3", "720"...), which are not part of a name
 * @returns the link; undefined after replying when there is nothing to work with
 */
async function youtubeTarget(ctx: CommandContext, options: string[], help: string): Promise<string | undefined> {
  const raw = findUrl(ctx.text) ?? findUrl(ctx.quoted?.text ?? '');
  if (raw) {
    const url = parseMediaUrl(raw, ['youtube']);
    if (!url) await ctx.reply(fail('That is not a YouTube link', `For other sites use ${ctx.prefix}fb, ${ctx.prefix}tiktok, ${ctx.prefix}insta or ${ctx.prefix}x.`));
    return url;
  }
  const query = ctx.args.filter((word, index) => !((index === 0 || index === ctx.args.length - 1) && options.includes(word.toLowerCase()))).join(' ');
  if (!query) {
    await ctx.reply(help);
    return undefined;
  }
  await ctx.react('🔎');
  const results = await attempt(ctx, 'Search failed', () => searchYouTube(query, 1));
  if (!results) return undefined;
  if (results.length === 0) await ctx.reply(fail('Nothing found', `No YouTube result for "${query}".`));
  return results[0]?.url;
}

/** The option word of a format command: the first or the last word typed, so a name may contain such words. */
function optionWord(ctx: CommandContext, options: string[]): string | undefined {
  const first = ctx.args[0]?.toLowerCase() ?? '';
  const last = ctx.args.at(-1)?.toLowerCase() ?? '';
  return options.includes(first) ? first : options.includes(last) ? last : undefined;
}

const audioChoices = (url: string) => ({
  standard: choice('🎵 Audio', 'plays in the chat', `yta std ${url}`),
  file: choice('📄 Audio file', 'MP3 document', `yta doc ${url}`),
  mp3: choice('🎧 MP3 192 kbps', 'best quality', `yta mp3 ${url}`),
  small: choice('🪶 Small 64 kbps', 'saves data', `yta small ${url}`),
  voice: choice('🎙️ Voice note', '', `yta voice ${url}`)
});
const videoChoices = (url: string) => ({
  standard: choice('🎬 Video', '480p, plays in the chat', `ytv 480 ${url}`),
  file: choice('📄 Video file', '720p document', `ytv doc ${url}`),
  low: choice('🎬 Video 360p', 'smallest', `ytv 360 ${url}`),
  hd: choice('🎬 Video 720p', 'HD', `ytv 720 ${url}`),
  fullHd: choice('🎬 Video 1080p', 'full HD', `ytv 1080 ${url}`)
});

/** The details of a video with its thumbnail, and a choice of formats: numbered, or as buttons. */
async function sendPicker(ctx: CommandContext, info: MediaInfo, focus: 'audio' | 'video' | 'both'): Promise<void> {
  const audio = audioChoices(info.url);
  const video = videoChoices(info.url);
  // The first two are the buttons; the others wait behind "More options".
  const options =
    focus === 'audio'
      ? [audio.standard, audio.file, audio.mp3, audio.small, audio.voice, video.standard]
      : focus === 'video'
        ? [video.standard, video.file, video.low, video.hd, video.fullHd, audio.standard]
        : [audio.standard, video.standard, audio.file, video.file, audio.mp3, audio.voice, video.low, video.hd];
  await sendMenu(ctx.bot, ctx.jid, {
    header: card(focus === 'video' ? '🎬' : '🎵', focus === 'video' ? 'Video' : focus === 'audio' ? 'Song' : 'Download', [...infoRows(info), `🔗 ${info.url}`]),
    options,
    footer: quote(italic('Reply with a number to choose a format')),
    quoted: ctx.msg,
    image: await remoteThumbnail(info.thumbnail),
    style: 'buttons'
  });
}

/** `.fb`, `.tiktok`, `.insta`... : download what is behind a link from one service. */
function siteCommand(name: string, aliases: string[], site: Site, example: string, defaultKind: MediaKind = 'video'): Command {
  const label = SITE_LABEL[site];
  const thing = defaultKind === 'audio' ? 'track' : 'video';
  return {
    name,
    aliases,
    category: 'download',
    description: `Download ${/^[AEIOX]/.test(label) ? 'an' : 'a'} ${label} ${thing} from its link.`,
    usage: `${name} <link> [audio] [doc]`,
    cooldown: 15,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const url = linkFrom(ctx, [site]);
      if (!url) {
        await ctx.reply(
          `${fail(`Send a ${label} link`)}\n${usage(ctx.prefix, `${name} <link> [audio] [doc]`, `${name} ${example}`)}\n${note('Add "audio" for sound only, or "doc" to get it as a file. You can also reply to a message that contains the link.')}`
        );
        return;
      }
      const kind: MediaKind = hasWord(ctx, 'audio') || hasWord(ctx, 'mp3') ? 'audio' : hasWord(ctx, 'video') ? 'video' : defaultKind;
      const asDocument = hasWord(ctx, 'doc') || hasWord(ctx, 'file');
      await deliver(ctx, url, { kind, asDocument, announce: kind === 'audio' }, '📥', `${label} ${kind === 'audio' ? 'audio' : 'video'}`);
    }
  };
}

export const downloadCommands: Command[] = [
  {
    name: 'yts',
    aliases: ['ytsearch', 'youtube'],
    category: 'download',
    description: 'Search YouTube and list the top results.',
    usage: 'yts <words>',
    cooldown: 8,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const query = ctx.text.trim();
      if (!query) {
        await ctx.reply(usage(ctx.prefix, 'yts <words>', 'yts lofi study mix'));
        return;
      }
      await ctx.react('🔎');
      const results = await attempt(ctx, 'Search failed', () => searchYouTube(query, 8));
      if (!results) return;
      if (results.length === 0) {
        await ctx.reply(fail('Nothing found', `No YouTube result for "${query}".`));
        return;
      }
      // Replying with a number opens the format choice for that result.
      const options: MenuOption[] = results.map(item => ({
        label: [
          bold(item.title.slice(0, 90)),
          `   ⏱️ ${clock(item.durationSeconds)}  👤 ${item.uploader ?? 'unknown'}${item.views ? `  👁️ ${compact(item.views)}` : ''}`,
          `   🔗 ${item.url}`
        ].join('\n'),
        action: { type: 'command', text: `ytpick ${item.url}` }
      }));
      await sendMenu(ctx.bot, ctx.jid, {
        header: card('🔎', 'YouTube search', [field('Query', query), field('Results', results.length)]),
        options,
        footer: quote(italic('Reply with a number to download that result')),
        quoted: ctx.msg,
        image: await remoteThumbnail(results[0].thumbnail)
      });
    }
  },
  {
    // Second step of the search menu; also usable directly with a link.
    name: 'ytpick',
    category: 'download',
    description: 'Show the download formats for a YouTube link.',
    usage: 'ytpick <link>',
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const url = linkFrom(ctx, ['youtube']);
      if (!url) {
        await ctx.reply(usage(ctx.prefix, 'ytpick <link>'));
        return;
      }
      await ctx.react('🔎');
      const info = await attempt(ctx, 'Could not open that video', () => lookupMedia(url));
      if (info) await sendPicker(ctx, info, 'both');
    }
  },
  {
    name: 'song',
    aliases: ['music', 'audio'],
    category: 'download',
    description: 'Find a song and ask the person how they want it: audio, MP3, small file, voice note or document.',
    usage: 'song <name or link>',
    cooldown: 10,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const info = await findYouTube(ctx, 'song lofi study beats');
      if (info) await sendPicker(ctx, info, 'audio');
    }
  },
  {
    name: 'video',
    aliases: ['vid', 'ytvideo'],
    category: 'download',
    description: 'Find a video and ask the person which quality they want: 360p to 1080p, or as a document.',
    usage: 'video <name or link>',
    cooldown: 10,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const info = await findYouTube(ctx, 'video how to tie a tie');
      if (info) await sendPicker(ctx, info, 'video');
    }
  },
  {
    name: 'play',
    aliases: ['p'],
    category: 'download',
    description: 'Send a song straight away as audio, by name or link, no questions asked.',
    usage: 'play <name or link>',
    cooldown: 15,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const info = await findYouTube(ctx, 'play lofi study beats');
      if (info) await deliver(ctx, info.url, { kind: 'audio', announce: true }, '🎵', 'Now playing');
    }
  },
  {
    name: 'yta',
    aliases: ['ytmp3', 'ytaudio'],
    category: 'download',
    description: 'Download a song from YouTube straight away, by name or link, in a chosen format: std (plays in the chat), mp3, small, voice (voice note) or doc (MP3 file).',
    usage: 'yta [std|mp3|small|voice|doc] <name or link>',
    cooldown: 15,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const modes = ['std', 'mp3', 'small', 'voice', 'doc'];
      const url = await youtubeTarget(
        ctx,
        modes,
        `${usage(ctx.prefix, 'yta [std|mp3|small|voice|doc] <name or link>', 'yta mp3 lofi study beats')}\n${note('std: standard audio. mp3: 192 kbps MP3. small: 64 kbps. voice: voice note. doc: as a file.')}`
      );
      if (!url) return;
      const mode = optionWord(ctx, modes) ?? 'std';
      // Found by name: say which track it is before the audio arrives.
      const byName = !findUrl(ctx.text) && !findUrl(ctx.quoted?.text ?? '');
      const deliveries: Record<string, Delivery> = {
        std: { kind: 'audio' },
        mp3: { kind: 'audio', audio: 'mp3' },
        small: { kind: 'audio', audio: 'small' },
        voice: { kind: 'audio', audio: 'small', voice: true },
        doc: { kind: 'audio', audio: 'mp3', asDocument: true }
      };
      await deliver(ctx, url, { ...deliveries[mode], announce: byName }, '🎵', 'Song');
    }
  },
  {
    name: 'ytv',
    aliases: ['ytmp4'],
    category: 'download',
    description: 'Download a video from YouTube straight away, by name or link, in a chosen quality (360, 480, 720 or 1080), or as a file (doc).',
    usage: 'ytv [360|480|720|1080|doc] <name or link>',
    cooldown: 15,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const options = ['360', '480', '720', '1080', '360p', '480p', '720p', '1080p', 'doc'];
      const url = await youtubeTarget(
        ctx,
        options,
        `${usage(ctx.prefix, 'ytv [360|480|720|1080|doc] <name or link>', 'ytv 480 how to tie a tie')}\n${note('A lower quality is used automatically when the chosen one would exceed the size limit.')}`
      );
      if (!url) return;
      const option = optionWord(ctx, options);
      const height = Number.parseInt(option ?? '', 10) || 720;
      await deliver(ctx, url, { kind: 'video', maxHeight: height, asDocument: option === 'doc' }, '🎬', `Video ${height}p`);
    }
  },
  {
    name: 'thumb',
    aliases: ['thumbnail', 'ytthumb'],
    category: 'download',
    description: 'Get the thumbnail image of a YouTube video.',
    usage: 'thumb <name or link>',
    cooldown: 8,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const info = await findYouTube(ctx, 'thumb https://youtu.be/abc123');
      if (!info) return;
      // The largest poster YouTube has; older videos only have the smaller one.
      const image = (await remoteThumbnail(`https://i.ytimg.com/vi/${info.id}/maxresdefault.jpg`, 1280)) ?? (await remoteThumbnail(info.thumbnail, 1280));
      if (!image) {
        await ctx.reply(fail('No thumbnail found'));
        return;
      }
      await ctx.reply({ image, caption: card('🖼️', 'Thumbnail', infoRows(info)) });
    }
  },
  siteCommand('fb', ['facebook', 'fbdl'], 'facebook', 'https://fb.watch/abc123'),
  siteCommand('tiktok', ['tt', 'ttdl'], 'tiktok', 'https://vm.tiktok.com/abc123'),
  siteCommand('insta', ['ig', 'instagram', 'reel'], 'instagram', 'https://www.instagram.com/reel/abc123'),
  siteCommand('x', ['twitter', 'tw'], 'twitter', 'https://x.com/user/status/123'),
  siteCommand('pin', ['pinterest'], 'pinterest', 'https://pin.it/abc123'),
  siteCommand('threads', [], 'threads', 'https://www.threads.net/@user/post/abc'),
  siteCommand('snap', ['snapchat'], 'snapchat', 'https://www.snapchat.com/spotlight/abc'),
  siteCommand('reddit', ['rd'], 'reddit', 'https://www.reddit.com/r/videos/comments/abc'),
  siteCommand('soundcloud', ['sc'], 'soundcloud', 'https://soundcloud.com/artist/track', 'audio'),
  siteCommand('vimeo', [], 'vimeo', 'https://vimeo.com/123456'),
  siteCommand('dailymotion', ['dm'], 'dailymotion', 'https://www.dailymotion.com/video/abc'),
  siteCommand('twitch', ['clip'], 'twitch', 'https://clips.twitch.tv/abc'),
  siteCommand('bilibili', ['bili'], 'bilibili', 'https://www.bilibili.com/video/abc'),
  siteCommand('likee', [], 'likee', 'https://likee.video/@user/video/123'),
  {
    name: 'dl',
    aliases: ['download'],
    category: 'download',
    description: 'Download from any other supported site.',
    usage: 'dl <link> [audio] [doc]',
    // Arbitrary links make this server fetch arbitrary pages, so this one stays with owners.
    ownerOnly: true,
    async execute(ctx) {
      if (!ctx.settings.downloads.enabled) {
        await ctx.reply(fail('Downloads are switched off'));
        return;
      }
      const url = linkFrom(ctx);
      if (!url) {
        await ctx.reply(usage(ctx.prefix, 'dl <link> [audio] [doc]', 'dl https://example.com/video/123'));
        return;
      }
      const audio = hasWord(ctx, 'audio');
      await deliver(ctx, url, { kind: audio ? 'audio' : 'video', asDocument: hasWord(ctx, 'doc'), announce: audio }, '📥', audio ? 'Audio' : 'Video');
    }
  },
  {
    name: 'updatedl',
    category: 'download',
    description: 'Update the downloader when sites stop working.',
    ownerOnly: true,
    async execute(ctx) {
      await ctx.react('⏳');
      try {
        await installYtDlp();
        await ctx.reply(`✅ ${bold('Downloader updated')}\n${note('yt-dlp is now on its latest release.')}`);
      } catch (error) {
        await ctx.reply(fail('Update failed', error instanceof Error ? error.message : undefined));
      }
    }
  }
];
