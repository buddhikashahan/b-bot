import { AiError, converse, clearMemory, getApiKey, runActions, type Question } from '../../features/ai.js';
import { updateSettings } from '../../settings.js';
import { bold, fail, note, usage } from '../../whatsapp/format.js';
import { contentOf } from '../../whatsapp/message-utils.js';
import type { Command, CommandContext } from '../types.js';

/** The photo this command is about: attached to the command, or in the message it replies to. */
async function photoOf(ctx: CommandContext): Promise<Buffer | undefined> {
  if (contentOf(ctx.msg.message)?.imageMessage) return ctx.bot.download(ctx.msg);
  if (ctx.quoted?.content.imageMessage) return ctx.bot.download(ctx.quoted.message);
  return undefined;
}

/** Ask the model and reply, turning AI failures into a readable message. */
async function respond(ctx: CommandContext, question: Omit<Question, 'chatJid' | 'senderName' | 'group'>): Promise<void> {
  await ctx.sock.sendPresenceUpdate('composing', ctx.jid).catch(() => {});
  try {
    const { answer, actions } = await converse(ctx.bot, { ...question, chatJid: ctx.jid, senderName: ctx.senderName, group: ctx.group?.subject });
    if (answer) await ctx.reply(answer);
    // What the assistant decided to do rather than say, e.g. download a song; the file is the reply.
    await runActions(ctx.bot, ctx.msg, actions);
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    await ctx.reply(fail('The AI could not answer', error.message));
  } finally {
    await ctx.sock.sendPresenceUpdate('paused', ctx.jid).catch(() => {});
  }
}

export const aiCommands: Command[] = [
  {
    name: 'ai',
    aliases: ['ask', 'gemini', 'gpt', 'bot'],
    category: 'ai',
    description: 'Ask the AI anything, or ask it for a song or video. Attach or reply to a photo to ask about it.',
    usage: 'ai <question>',
    cooldown: 5,
    async execute(ctx) {
      const image = await photoOf(ctx);
      const quoted = ctx.quoted?.text.trim();
      if (!ctx.text.trim() && !image && !quoted) {
        await ctx.reply(`${usage(ctx.prefix, 'ai <question>', 'ai explain black holes simply')}\n${note('Reply to a message or photo with this command to ask about it.')}`);
        return;
      }
      // A replied-to message becomes part of the question, so "what does this mean?" works.
      const text = quoted && !image ? `About this message: "${quoted.slice(0, 3000)}"\n\n${ctx.text.trim() || 'Explain it.'}` : ctx.text.trim();
      await respond(ctx, { text, image, msg: ctx.msg });
    }
  },
  {
    name: 'summarize',
    aliases: ['tldr', 'summary'],
    category: 'ai',
    description: 'Summarise the long message you reply to.',
    cooldown: 10,
    async execute(ctx) {
      const text = ctx.quoted?.text.trim() || ctx.text.trim();
      if (text.length < 80) {
        await ctx.reply(note('Reply to a long message with this command and I will shorten it.'));
        return;
      }
      await respond(ctx, {
        text: text.slice(0, 12_000),
        stateless: true,
        instruction: 'Summarise the message you are given in a few short bullet points, in the same language it is written in. Output only the summary.'
      });
    }
  },
  {
    name: 'ocr',
    aliases: ['readtext', 'scan'],
    category: 'ai',
    description: 'Read the text in a photo (attach it, or reply to it).',
    cooldown: 10,
    async execute(ctx) {
      const image = await photoOf(ctx);
      if (!image) {
        await ctx.reply(note('Send a photo with this command as its caption, or reply to a photo.'));
        return;
      }
      await respond(ctx, {
        text: 'Copy out the text in this image.',
        image,
        stateless: true,
        instruction: 'Transcribe all text visible in the image exactly as written, keeping line breaks. If there is no text, say so in one short sentence. Output only the transcription.'
      });
    }
  },
  {
    name: 'describe',
    aliases: ['whatisthis'],
    category: 'ai',
    description: 'Describe what is in a photo (attach it, or reply to it).',
    cooldown: 10,
    async execute(ctx) {
      const image = await photoOf(ctx);
      if (!image) {
        await ctx.reply(note('Send a photo with this command as its caption, or reply to a photo.'));
        return;
      }
      await respond(ctx, { text: ctx.text.trim() || 'Describe this picture clearly in a few sentences.', image, stateless: true, instruction: 'You describe images accurately and concisely.' });
    }
  },
  {
    name: 'resetai',
    aliases: ['forget', 'newchat'],
    category: 'ai',
    description: 'Make the AI forget the conversation in this chat and start fresh.',
    cooldown: 5,
    async execute(ctx) {
      // In a group, wiping everyone's shared context is an admin decision.
      if (ctx.isGroup && !ctx.isAdmin && !ctx.isOwner) {
        await ctx.reply(`🛡️ ${bold('Admin command')}\n${note('Only group admins can reset the AI memory of a group.')}`);
        return;
      }
      await clearMemory(ctx.bot.id, ctx.jid);
      await ctx.reply(`🧹 ${bold('Memory cleared')}\n${note('The AI no longer remembers earlier messages in this chat.')}`);
    }
  },
  {
    name: 'assistant',
    aliases: ['chatbot', 'autoai'],
    category: 'ai',
    description: 'Turn automatic AI replies on or off.',
    usage: 'assistant on|off',
    ownerOnly: true,
    async execute(ctx) {
      const choice = ctx.args[0]?.toLowerCase();
      if (choice !== 'on' && choice !== 'off') {
        await ctx.reply(`🤖 The AI assistant is ${bold(ctx.settings.ai.enabled ? 'on' : 'off')}.\n${usage(ctx.prefix, 'assistant on|off')}`);
        return;
      }
      if (choice === 'on' && !(await getApiKey())) {
        await ctx.reply(fail('No API key yet', 'Add a Gemini API key on the Assistant page of the dashboard first.'));
        return;
      }
      await updateSettings({ ai: { enabled: choice === 'on' } });
      await ctx.reply(choice === 'on' ? `🤖 ${bold('AI assistant on')}\n${note('I will answer ordinary messages. Commands still work as before.')}` : `🤖 ${bold('AI assistant off')}`);
    }
  }
];
