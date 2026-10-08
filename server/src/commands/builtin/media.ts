import sharp, { type Sharp } from 'sharp';
import { convert, MediaError, toAnimatedSticker, toGifVideo, toMp3, toVoiceNote } from '../../features/media-tools.js';
import { fail, note, usage } from '../../whatsapp/format.js';
import { contentOf, mediaOf, type MediaKind } from '../../whatsapp/message-utils.js';
import type { Command, CommandContext } from '../types.js';

/** Largest file the conversion commands will take in. */
const MAX_INPUT_BYTES = 40 * 1024 * 1024;
/** WhatsApp refuses animated stickers much beyond this. */
const MAX_STICKER_BYTES = 900 * 1024;

const KIND_WORDS: Record<MediaKind, string> = { image: 'a photo', video: 'a video', audio: 'an audio or voice note', document: 'a file', sticker: 'a sticker' };

/** The media message a command refers to: the quoted one, else the command message itself. */
function sourceMessage(ctx: CommandContext) {
  return ctx.quoted ? { message: ctx.quoted.message, content: ctx.quoted.content } : { message: ctx.msg, content: contentOf(ctx.msg.message) };
}

/**
 * Download the media a command is about. Replies with a hint and returns undefined
 * when there is none of the accepted kinds, or it is too big.
 */
async function mediaFor(ctx: CommandContext, accepted: MediaKind[]): Promise<{ data: Buffer; kind: MediaKind; voiceNote: boolean; gif: boolean } | undefined> {
  const { message, content } = sourceMessage(ctx);
  const media = mediaOf(content);
  if (!media || !accepted.includes(media.kind)) {
    const wanted = accepted.map(kind => KIND_WORDS[kind]).join(' or ');
    await ctx.reply(note(`Send ${wanted} with ${ctx.prefix}${ctx.command} as the caption, or reply to one with the command.`));
    return undefined;
  }
  if ((media.sizeBytes ?? 0) > MAX_INPUT_BYTES) {
    await ctx.reply(fail('That file is too big', `I can convert files up to ${MAX_INPUT_BYTES / 1024 / 1024} MB.`));
    return undefined;
  }
  return { data: await ctx.bot.download(message), kind: media.kind, voiceNote: Boolean(media.ptt), gif: Boolean(media.gif) };
}

/** Wrap a command body so conversion problems become a tidy reply. */
function media(run: Command['execute']): Command['execute'] {
  return async ctx => {
    try {
      await run(ctx);
    } catch (error) {
      if (!(error instanceof MediaError)) throw error;
      await ctx.react('❌');
      await ctx.reply(fail('Could not convert that', error.message));
    }
  };
}

function toSticker(image: Buffer | Sharp): Promise<Buffer> {
  const pipeline = Buffer.isBuffer(image) ? sharp(image) : image;
  return pipeline
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toBuffer();
}

/** A photo command that edits the picture with sharp and sends it back. */
function imageEffect(
  name: string,
  aliases: string[],
  description: string,
  apply: (image: Sharp, ctx: CommandContext) => Sharp | Promise<Sharp>,
  commandUsage?: string
): Command {
  return {
    name,
    aliases,
    category: 'media',
    description,
    usage: commandUsage,
    cooldown: 5,
    execute: media(async ctx => {
      const source = await mediaFor(ctx, ['image', 'sticker']);
      if (!source) return;
      // Apply the camera orientation first so every effect works on the picture as it is seen.
      const upright = await sharp(source.data).rotate().toBuffer();
      const edited = await apply(sharp(upright), ctx);
      await ctx.reply({ image: await edited.flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer() });
    })
  };
}

/** A sound command that runs the audio (or a video's sound track) through an ffmpeg filter. */
function audioEffect(name: string, aliases: string[], description: string, filter: string): Command {
  return {
    name,
    aliases,
    category: 'media',
    description,
    cooldown: 10,
    execute: media(async ctx => {
      const source = await mediaFor(ctx, ['audio', 'video']);
      if (!source) return;
      await ctx.react('⏳');
      // A voice note stays a voice note; anything else comes back as an MP3.
      if (source.voiceNote) {
        const audio = await convert(source.data, [], ['-vn', '-af', filter, '-c:a', 'libopus', '-b:a', '48k', '-ac', '1', '-ar', '48000'], 'ogg');
        await ctx.reply({ audio, mimetype: 'audio/ogg; codecs=opus', ptt: true });
      } else {
        const audio = await convert(source.data, [], ['-vn', '-af', filter, '-c:a', 'libmp3lame', '-b:a', '128k'], 'mp3');
        await ctx.reply({ audio, mimetype: 'audio/mpeg' });
      }
      await ctx.react('✅');
    })
  };
}

/** "75", "1:15" or "0:01:15" -> seconds. */
export function parseTimestamp(input: string | undefined): number | undefined {
  if (!input || !/^\d{1,5}(:\d{1,2}){0,2}$/.test(input)) return undefined;
  return input.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

const escapeXml = (text: string) => text.replace(/[<>&'"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char] ?? char);

/** Break a caption into lines that fit the picture. */
function wrapCaption(text: string, perLine: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > perLine) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

/** Classic meme lettering: white capitals with a black outline, at the top and bottom. */
function memeOverlay(width: number, height: number, top: string, bottom: string): Buffer {
  const size = Math.max(18, Math.round(width / 11));
  const perLine = Math.max(8, Math.floor(width / (size * 0.58)));
  const text = (lines: string[], firstBaseline: number) =>
    lines
      .map((line, index) => `<text x="50%" y="${firstBaseline + index * size * 1.1}" text-anchor="middle">${escapeXml(line.toUpperCase())}</text>`)
      .join('');
  const topLines = wrapCaption(top, perLine);
  const bottomLines = wrapCaption(bottom, perLine);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <g font-family="Impact, 'Arial Black', 'DejaVu Sans', sans-serif" font-weight="bold" font-size="${size}" fill="#fff" stroke="#000" stroke-width="${Math.max(2, size / 12)}" paint-order="stroke" stroke-linejoin="round">
      ${text(topLines, size * 1.1)}
      ${text(bottomLines, height - size * 0.35 - (bottomLines.length - 1) * size * 1.1)}
    </g>
  </svg>`;
  return Buffer.from(svg);
}

export const mediaCommands: Command[] = [
  {
    name: 'sticker',
    aliases: ['s', 'stiker', 'stick'],
    category: 'media',
    description: 'Turn a photo, GIF or short video into a sticker.',
    cooldown: 5,
    execute: media(async ctx => {
      const source = await mediaFor(ctx, ['image', 'video']);
      if (!source) return;
      if (source.kind === 'image') {
        await ctx.reply({ sticker: await toSticker(source.data) });
        return;
      }
      await ctx.react('⏳');
      let sticker = await toAnimatedSticker(source.data);
      if (sticker.length > MAX_STICKER_BYTES) sticker = await toAnimatedSticker(source.data, true);
      if (sticker.length > MAX_STICKER_BYTES) {
        await ctx.react('❌');
        await ctx.reply(fail('That clip is too long for a sticker', 'Try a shorter or simpler clip (a few seconds works best).'));
        return;
      }
      await ctx.reply({ sticker });
      await ctx.react('✅');
    })
  },
  {
    name: 'circle',
    aliases: ['round'],
    category: 'media',
    description: 'Make a round sticker from a photo.',
    cooldown: 5,
    async execute(ctx) {
      const source = await mediaFor(ctx, ['image', 'sticker']);
      if (!source) return;
      const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><circle cx="256" cy="256" r="256"/></svg>');
      const round = sharp(source.data)
        .rotate()
        .resize(512, 512, { fit: 'cover' })
        .ensureAlpha()
        .composite([{ input: mask, blend: 'dest-in' }]);
      await ctx.reply({ sticker: await round.webp({ quality: 85 }).toBuffer() });
    }
  },
  {
    name: 'toimg',
    aliases: ['toimage', 'photo'],
    category: 'media',
    description: 'Convert the sticker you reply to back into an image.',
    cooldown: 5,
    async execute(ctx) {
      const source = await mediaFor(ctx, ['sticker']);
      if (!source) return;
      // Animated stickers collapse to their first frame.
      await ctx.reply({ image: await sharp(source.data).png().toBuffer() });
    }
  },
  {
    name: 'tomp3',
    aliases: ['toaudio', 'mp3', 'extract'],
    category: 'media',
    description: 'Pull the sound out of a video, or turn a voice note into an MP3.',
    cooldown: 10,
    execute: media(async ctx => {
      const source = await mediaFor(ctx, ['video', 'audio']);
      if (!source) return;
      await ctx.react('⏳');
      await ctx.reply({ audio: await toMp3(source.data), mimetype: 'audio/mpeg', fileName: 'audio.mp3' });
      await ctx.react('✅');
    })
  },
  {
    name: 'tovn',
    aliases: ['ptt', 'tovoice', 'vn'],
    category: 'media',
    description: 'Turn an audio file or a video into a voice note.',
    cooldown: 10,
    execute: media(async ctx => {
      const source = await mediaFor(ctx, ['audio', 'video']);
      if (!source) return;
      await ctx.react('⏳');
      await ctx.reply({ audio: await toVoiceNote(source.data), mimetype: 'audio/ogg; codecs=opus', ptt: true });
      await ctx.react('✅');
    })
  },
  {
    name: 'togif',
    aliases: ['gif'],
    category: 'media',
    description: 'Turn a short video into a looping GIF.',
    cooldown: 10,
    execute: media(async ctx => {
      const source = await mediaFor(ctx, ['video']);
      if (!source) return;
      await ctx.react('⏳');
      await ctx.reply({ video: await toGifVideo(source.data), gifPlayback: true, mimetype: 'video/mp4' });
      await ctx.react('✅');
    })
  },
  {
    name: 'trim',
    aliases: ['cut'],
    category: 'media',
    description: 'Cut a piece out of an audio or video file.',
    usage: 'trim <start> <end>',
    cooldown: 10,
    execute: media(async ctx => {
      const start = parseTimestamp(ctx.args[0]);
      const end = parseTimestamp(ctx.args[1]);
      if (start === undefined || end === undefined || end <= start) {
        await ctx.reply(`${usage(ctx.prefix, 'trim <start> <end>', 'trim 0:30 1:15')}\n${note('Times are in seconds or m:ss. Reply to the audio or video you want to cut.')}`);
        return;
      }
      const source = await mediaFor(ctx, ['audio', 'video']);
      if (!source) return;
      await ctx.react('⏳');
      const range = ['-ss', String(start), '-to', String(end)];
      if (source.kind === 'video') {
        const video = await convert(
          source.data,
          [],
          [...range, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
          'mp4'
        );
        await ctx.reply({ video, mimetype: 'video/mp4' });
      } else {
        const audio = await convert(source.data, [], [...range, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k'], 'mp3');
        await ctx.reply({ audio, mimetype: 'audio/mpeg' });
      }
      await ctx.react('✅');
    })
  },

  // --- sound effects ---------------------------------------------------------------------------
  audioEffect('bass', ['bassboost'], 'Boost the bass of an audio or voice note.', 'bass=g=14,volume=0.9'),
  audioEffect('nightcore', [], 'Faster and higher: the nightcore effect.', 'aresample=44100,asetrate=44100*1.25,aresample=44100'),
  audioEffect('slow', ['slowed'], 'Slow an audio down.', 'atempo=0.8'),
  audioEffect('fast', ['speedup'], 'Speed an audio up.', 'atempo=1.35'),
  audioEffect('deep', [], 'Make a voice deep.', 'aresample=44100,asetrate=44100*0.78,aresample=44100,atempo=1.2'),
  audioEffect('chipmunk', ['squeaky'], 'Make a voice squeaky.', 'aresample=44100,asetrate=44100*1.5,aresample=44100,atempo=0.8'),
  audioEffect('reverse', [], 'Play an audio backwards.', 'areverse'),

  // --- photo effects ---------------------------------------------------------------------------
  imageEffect(
    'blur',
    [],
    'Blur a photo.',
    (image, ctx) => image.blur(Math.min(Math.max(Number.parseInt(ctx.args[0] ?? '12', 10) || 12, 1), 60)),
    'blur [1-60]'
  ),
  imageEffect('grey', ['gray', 'bw', 'greyscale'], 'Make a photo black and white.', image => image.grayscale()),
  imageEffect('invert', ['negative'], 'Invert the colours of a photo.', image => image.negate({ alpha: false })),
  imageEffect('vflip', ['upsidedown', 'flipimg'], 'Turn a photo upside down.', image => image.flip()),
  imageEffect('mirror', ['flop'], 'Mirror a photo left to right.', image => image.flop()),
  imageEffect(
    'rotate',
    [],
    'Rotate a photo.',
    (image, ctx) => image.rotate(((Number.parseInt(ctx.args[0] ?? '90', 10) || 90) % 360) + 0, { background: '#ffffff' }),
    'rotate [degrees]'
  ),
  imageEffect('enhance', ['hd', 'sharpen', 'remini'], 'Sharpen a photo and lift its colours.', async image => {
    const { width = 0, height = 0 } = await image.metadata();
    // Double small pictures, without going past what WhatsApp will show anyway.
    const scale = Math.min(2, 2560 / Math.max(width, height, 1));
    const sized = scale > 1 ? image.resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' }) : image;
    return sized.normalise().modulate({ saturation: 1.12 }).sharpen({ sigma: 1.1 });
  }),
  imageEffect(
    'meme',
    ['caption'],
    'Write a meme caption on a photo.',
    async (image, ctx) => {
      const [top = '', bottom = ''] = ctx.text.split('|').map(part => part.trim());
      if (!top && !bottom) throw new MediaError(`Tell me what to write: ${ctx.prefix}meme top text | bottom text`);
      const { width = 0, height = 0 } = await image.metadata();
      if (!width || !height) throw new MediaError('I could not read that picture.');
      return image.composite([{ input: memeOverlay(width, height, top.slice(0, 120), bottom.slice(0, 120)) }]);
    },
    'meme <top text> | <bottom text>'
  )
];
