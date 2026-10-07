import sharp from 'sharp';
import { contentOf } from '../../whatsapp/message-utils.js';
import type { Command, CommandContext } from '../types.js';

/** The media message a command refers to: the quoted one, else the command message itself. */
function sourceMessage(ctx: CommandContext) {
  return ctx.quoted ? { message: ctx.quoted.message, content: ctx.quoted.content } : { message: ctx.msg, content: contentOf(ctx.msg.message) };
}

export const mediaCommands: Command[] = [
  {
    name: 'sticker',
    aliases: ['s', 'stiker'],
    category: 'media',
    description: 'Turn an image into a sticker (send it with the command or reply to it).',
    cooldown: 5,
    async execute(ctx) {
      const { message, content } = sourceMessage(ctx);
      if (!content?.imageMessage) {
        await ctx.reply(`Send an image with the caption ${ctx.prefix}sticker, or reply to one. Videos are not supported.`);
        return;
      }
      const image = await ctx.bot.download(message);
      const sticker = await sharp(image)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80 })
        .toBuffer();
      await ctx.reply({ sticker });
    }
  },
  {
    name: 'toimg',
    aliases: ['toimage'],
    category: 'media',
    description: 'Convert the sticker you reply to back into an image.',
    cooldown: 5,
    async execute(ctx) {
      const { message, content } = sourceMessage(ctx);
      if (!content?.stickerMessage) {
        await ctx.reply('Reply to a sticker with this command.');
        return;
      }
      const sticker = await ctx.bot.download(message);
      // Animated stickers collapse to their first frame.
      const image = await sharp(sticker).png().toBuffer();
      await ctx.reply({ image });
    }
  }
];
