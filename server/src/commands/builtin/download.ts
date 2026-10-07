import { recordActivity } from '../../features/activity.js';
import { sendMenu, type MenuOption } from '../../features/menus.js';
import {
  DownloadError,
  downloadMedia,
  findUrl,
  installYtDlp,
  parseMediaUrl,
  searchYouTube,
  type MediaInfo,
  type MediaKind,
  type Site
} from '../../features/downloader.js';
import { bold, card, clock, compact, fail, field, fileSize, italic, note, quote, usage } from '../../whatsapp/format.js';
import type { Command, CommandContext } from '../types.js';

const SITE_LABEL: Record<Site, string> = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  twitter: 'X (Twitter)',
  pinterest: 'Pinterest'
};

/** Check the feature switches; replies and returns false when the caller may not download. */
async function allowed(ctx: CommandContext): Promise<boolean> {
  const { downloads } = ctx.settings;
  if (!downloads.enabled) {
    await ctx.reply(fail('Downloads are switched off', 'The owner can turn them on in the dashboard.'));
    return false;
  }
  if (downloads.ownerOnly && !ctx.isOwner) {
    await ctx.reply('🔒 Downloads are limited to the bot owner.');
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

/** Download `url` and deliver it to the chat, with reactions as a progress indicator. */
async function deliver(ctx: CommandContext, url: string, kind: MediaKind, icon: string, heading: string): Promise<void> {
  const { maxSizeMb, maxMinutes } = ctx.settings.downloads;
  await ctx.react('⏳');
  let media;
  try {
    media = await downloadMedia(url, kind, { maxSizeMb, maxMinutes });
  } catch (error) {
    await ctx.react('❌');
    if (error instanceof DownloadError) {
      await ctx.reply(fail('Download failed', error.message));
      return;
    }
    throw error;
  }

  try {
    const caption = card(icon, heading, infoRows(media.info, media.sizeBytes));
    const source = { url: media.file };
    const fileName = `${media.info.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'download'}.${media.extension}`;
    // Very large videos, and containers WhatsApp cannot play, go out as files.
    const asDocument = !media.playable || (kind === 'video' && media.sizeBytes > 64 * 1024 * 1024);

    if (asDocument) {
      await ctx.reply({ document: source, mimetype: media.mimetype, fileName, caption });
    } else if (kind === 'audio') {
      await ctx.reply(caption);
      await ctx.reply({ audio: source, mimetype: media.mimetype, fileName });
    } else {
      await ctx.reply({ video: source, mimetype: media.mimetype, caption });
    }
    await ctx.react('✅');
    recordActivity(ctx.bot.id, 'command', `Downloaded ${kind === 'audio' ? 'audio' : 'a video'}: ${media.info.title.slice(0, 80)}`, {
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

/** `.fb`, `.tiktok`, `.insta`... : download the video behind a link from one service. */
function siteCommand(name: string, aliases: string[], site: Site, example: string): Command {
  const label = SITE_LABEL[site];
  return {
    name,
    aliases,
    category: 'download',
    description: `Download ${/^[AEIOX]/.test(label) ? 'an' : 'a'} ${label} video from its link.`,
    usage: `${name} <link>`,
    cooldown: 15,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const url = linkFrom(ctx, [site]);
      if (!url) {
        await ctx.reply(`${fail(`Send a ${label} link`)}\n${usage(ctx.prefix, `${name} <link>`, `${name} ${example}`)}\n${note('You can also reply to a message that contains the link.')}`);
        return;
      }
      await deliver(ctx, url, 'video', '📥', `${label} video`);
    }
  };
}

/** Resolve "a YouTube link, or words to search for" to a single video. */
async function resolveYouTube(ctx: CommandContext): Promise<{ url: string } | undefined> {
  const raw = findUrl(ctx.text) ?? (ctx.text ? undefined : findUrl(ctx.quoted?.text ?? ''));
  if (raw) {
    const url = parseMediaUrl(raw, ['youtube']);
    if (!url) {
      await ctx.reply(fail('That is not a YouTube link', `For other sites use ${ctx.prefix}fb, ${ctx.prefix}tiktok, ${ctx.prefix}insta or ${ctx.prefix}x.`));
      return undefined;
    }
    return { url };
  }
  const query = ctx.text.trim();
  if (!query) return undefined;
  const [first] = await searchYouTube(query, 1);
  if (!first) {
    await ctx.reply(fail('Nothing found', `No YouTube result for "${query}".`));
    return undefined;
  }
  return { url: first.url };
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
      let results: MediaInfo[];
      try {
        results = await searchYouTube(query, 8);
      } catch (error) {
        if (!(error instanceof DownloadError)) throw error;
        await ctx.reply(fail('Search failed', error.message));
        return;
      }
      if (results.length === 0) {
        await ctx.reply(fail('Nothing found', `No YouTube result for "${query}".`));
        return;
      }
      // Replying with a number opens the "audio or video?" step for that result.
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
        quoted: ctx.msg
      });
    }
  },
  {
    // Second step of the search menu; also usable directly with a link.
    name: 'ytpick',
    category: 'download',
    description: 'Choose audio or video for a YouTube link.',
    usage: 'ytpick <link>',
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      const url = linkFrom(ctx, ['youtube']);
      if (!url) {
        await ctx.reply(usage(ctx.prefix, 'ytpick <link>'));
        return;
      }
      await sendMenu(ctx.bot, ctx.jid, {
        header: card('📥', 'Download as', [`🔗 ${url}`]),
        options: [
          { label: '🎵 Audio (song)', action: { type: 'command', text: `song ${url}` } },
          { label: '🎬 Video', action: { type: 'command', text: `video ${url}` } }
        ],
        quoted: ctx.msg
      });
    }
  },
  {
    name: 'song',
    aliases: ['play', 'music', 'ytmp3', 'yta'],
    category: 'download',
    description: 'Download a song as audio, by name or YouTube link.',
    usage: 'song <name or link>',
    cooldown: 15,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      try {
        const found = await resolveYouTube(ctx);
        if (!found) {
          if (!ctx.text.trim() && !findUrl(ctx.quoted?.text ?? '')) await ctx.reply(usage(ctx.prefix, 'song <name or link>', 'song lofi study beats'));
          return;
        }
        await deliver(ctx, found.url, 'audio', '🎵', 'Song');
      } catch (error) {
        if (!(error instanceof DownloadError)) throw error;
        await ctx.reply(fail('Download failed', error.message));
      }
    }
  },
  {
    name: 'video',
    aliases: ['ytmp4', 'ytv', 'ytvideo'],
    category: 'download',
    description: 'Download a YouTube video, by name or link.',
    usage: 'video <name or link>',
    cooldown: 15,
    async execute(ctx) {
      if (!(await allowed(ctx))) return;
      try {
        const found = await resolveYouTube(ctx);
        if (!found) {
          if (!ctx.text.trim() && !findUrl(ctx.quoted?.text ?? '')) await ctx.reply(usage(ctx.prefix, 'video <name or link>', 'video how to tie a tie'));
          return;
        }
        await deliver(ctx, found.url, 'video', '🎬', 'Video');
      } catch (error) {
        if (!(error instanceof DownloadError)) throw error;
        await ctx.reply(fail('Download failed', error.message));
      }
    }
  },
  siteCommand('fb', ['facebook', 'fbdl'], 'facebook', 'https://fb.watch/abc123'),
  siteCommand('tiktok', ['tt', 'ttdl'], 'tiktok', 'https://vm.tiktok.com/abc123'),
  siteCommand('insta', ['ig', 'instagram', 'reel'], 'instagram', 'https://www.instagram.com/reel/abc123'),
  siteCommand('x', ['twitter', 'tw'], 'twitter', 'https://x.com/user/status/123'),
  siteCommand('pin', ['pinterest'], 'pinterest', 'https://pin.it/abc123'),
  {
    name: 'dl',
    aliases: ['download'],
    category: 'download',
    description: 'Download a video from any other supported site.',
    usage: 'dl <link> [audio]',
    // Arbitrary links make this server fetch arbitrary pages, so this one stays with owners.
    ownerOnly: true,
    async execute(ctx) {
      if (!ctx.settings.downloads.enabled) {
        await ctx.reply(fail('Downloads are switched off'));
        return;
      }
      const url = linkFrom(ctx);
      if (!url) {
        await ctx.reply(usage(ctx.prefix, 'dl <link> [audio]', 'dl https://vimeo.com/123456'));
        return;
      }
      const audio = /\baudio\b/i.test(ctx.text.replace(url, ''));
      await deliver(ctx, url, audio ? 'audio' : 'video', '📥', audio ? 'Audio' : 'Video');
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
