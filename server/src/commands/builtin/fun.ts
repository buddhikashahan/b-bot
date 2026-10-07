import { randomInt } from 'node:crypto';
import type { Command } from '../types.js';
import { bold, card, code, italic, quote } from '../../whatsapp/format.js';

const pick = <T,>(items: readonly T[]): T => items[randomInt(items.length)];

const JOKES = [
  ['Why did the developer go broke?', 'Because he used up all his cache.'],
  ['Why do programmers mix up Halloween and Christmas?', 'Because Oct 31 equals Dec 25.'],
  ["Why was the phone wearing glasses?", 'It lost its contacts.'],
  ['What do you call a group chat with no messages?', 'A silent disco.'],
  ['Why did the WiFi break up with the router?', 'There was no connection.'],
  ['How does a bot say goodbye?', 'It logs off politely.'],
  ['Why did the sticker go to school?', 'To become a little more animated.'],
  ['What is a computer\'s favourite snack?', 'Microchips.'],
  ['Why was the battery so calm?', 'It finally found its charge of mind.'],
  ['What did the keyboard say to the typist?', 'You are just my type.']
] as const;

const FACTS = [
  'Honey does not spoil; jars found in ancient tombs were still edible.',
  'Octopuses have three hearts, and two of them stop beating while they swim.',
  'A day on Venus is longer than its year.',
  'Bananas are berries, but strawberries are not.',
  'The Eiffel Tower grows about 15 cm taller in summer as the iron expands.',
  'Sri Lanka has eight UNESCO World Heritage Sites.',
  'A bolt of lightning is around five times hotter than the surface of the Sun.',
  'Sharks existed before trees did.',
  'Your brain uses roughly 20% of your body\'s energy.',
  'There are more possible chess games than atoms in the observable universe.',
  'Sea otters hold hands while they sleep so they do not drift apart.',
  'The first SMS ever sent, in 1992, said "Merry Christmas".'
] as const;

const TRUTHS = [
  'What is the last thing you searched for on your phone?',
  'Who in this chat would you trust with your unlocked phone?',
  'What is a habit you wish you could drop?',
  'What is the most embarrassing nickname you have had?',
  'What is the longest you have gone without checking WhatsApp?',
  'Which message have you typed and then deleted most recently?',
  'What is one thing you pretend to like but do not?',
  'What is the funniest lie you told as a child?',
  'Who was your first crush?',
  'What is a food everyone loves that you cannot stand?'
] as const;

const DARES = [
  'Send the fifth photo in your gallery (if it is safe to share).',
  'Type your next three messages using only emojis.',
  'Change your status to "I lost a dare" for one hour.',
  'Send a voice note singing the chorus of the last song you heard.',
  'Describe the person above you in exactly three words.',
  'Send your most used sticker five times.',
  'Write a two-line poem about this group.',
  'Reply to the next message in ALL CAPS.',
  'Tell the group your screen time for today.',
  'Send a compliment to the last person who messaged here.'
] as const;

/** Letter styles built from Unicode maths alphabets (offsets from "A", "a" and "0"). */
const FANCY: [string, number, number, number | undefined][] = [
  ['Bold', 0x1d400, 0x1d41a, 0x1d7ce],
  ['Italic', 0x1d608, 0x1d622, undefined],
  ['Bold italic', 0x1d63c, 0x1d656, undefined],
  ['Script', 0x1d4d0, 0x1d4ea, undefined],
  ['Double', 0x1d538, 0x1d552, 0x1d7d8],
  ['Mono', 0x1d670, 0x1d68a, 0x1d7f6],
  ['Circled', 0x24b6, 0x24d0, undefined]
];
// Double-struck capitals that live outside the contiguous block.
const DOUBLE_EXCEPTIONS: Record<string, string> = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };

function restyle(text: string, upper: number, lower: number, digit: number | undefined, double: boolean): string {
  return [...text]
    .map(char => {
      if (double && DOUBLE_EXCEPTIONS[char]) return DOUBLE_EXCEPTIONS[char];
      const point = char.codePointAt(0)!;
      if (point >= 65 && point <= 90) return String.fromCodePoint(upper + point - 65);
      if (point >= 97 && point <= 122) return String.fromCodePoint(lower + point - 97);
      if (digit !== undefined && point >= 48 && point <= 57) return String.fromCodePoint(digit + point - 48);
      return char;
    })
    .join('');
}

const EIGHT_BALL = [
  'It is certain.',
  'Without a doubt.',
  'Yes, definitely.',
  'Most likely.',
  'Signs point to yes.',
  'Ask again later.',
  'Cannot predict now.',
  "Don't count on it.",
  'My sources say no.',
  'Very doubtful.'
];

export const funCommands: Command[] = [
  {
    name: '8ball',
    category: 'fun',
    description: 'Ask the magic 8-ball a yes/no question.',
    usage: '8ball <question>',
    cooldown: 3,
    async execute(ctx) {
      if (!ctx.text) {
        await ctx.reply('Ask me a question first.');
        return;
      }
      await ctx.reply(`🎱 ${EIGHT_BALL[randomInt(EIGHT_BALL.length)]}`);
    }
  },
  {
    name: 'flip',
    aliases: ['coin'],
    category: 'fun',
    description: 'Flip a coin.',
    cooldown: 3,
    async execute(ctx) {
      await ctx.reply(`🪙 ${randomInt(2) === 0 ? 'Heads' : 'Tails'}`);
    }
  },
  {
    name: 'choose',
    aliases: ['pick'],
    category: 'fun',
    description: 'Let the bot pick one of your options.',
    usage: 'choose <a> | <b> | <c>',
    cooldown: 3,
    async execute(ctx) {
      const options = ctx.text.split(/\||,/).map(option => option.trim()).filter(Boolean);
      if (options.length < 2) {
        await ctx.reply(`Give me at least two options: ${ctx.prefix}choose pizza | burgers | sushi`);
        return;
      }
      await ctx.reply(`🤔 I choose *${options[randomInt(options.length)]}*.`);
    }
  },
  {
    name: 'rate',
    category: 'fun',
    description: 'Rate anything out of 10.',
    usage: 'rate <thing>',
    cooldown: 3,
    async execute(ctx) {
      if (!ctx.text) {
        await ctx.reply(`What should I rate? ${ctx.prefix}rate my cooking`);
        return;
      }
      await ctx.reply(`⭐ I rate ${ctx.text.trim()} *${randomInt(11)}/10*.`);
    }
  },
  {
    name: 'joke',
    category: 'fun',
    description: 'Hear a joke.',
    cooldown: 3,
    async execute(ctx) {
      const [setup, punchline] = pick(JOKES);
      await ctx.reply(`😄 ${bold(setup)}\n${quote(punchline)}`);
    }
  },
  {
    name: 'fact',
    category: 'fun',
    description: 'Learn a random fact.',
    cooldown: 3,
    async execute(ctx) {
      await ctx.reply(`💡 ${bold('Did you know?')}\n${quote(pick(FACTS))}`);
    }
  },
  {
    name: 'truth',
    category: 'fun',
    description: 'Get a truth question for truth or dare.',
    cooldown: 3,
    async execute(ctx) {
      await ctx.reply(`🫣 ${bold('Truth')}\n${quote(pick(TRUTHS))}`);
    }
  },
  {
    name: 'dare',
    category: 'fun',
    description: 'Get a dare for truth or dare.',
    cooldown: 3,
    async execute(ctx) {
      await ctx.reply(`🔥 ${bold('Dare')}\n${quote(pick(DARES))}`);
    }
  },
  {
    name: 'fancy',
    aliases: ['font', 'style'],
    category: 'fun',
    description: 'Write your text in decorative letter styles.',
    usage: 'fancy <text>',
    cooldown: 3,
    async execute(ctx) {
      const text = (ctx.text || ctx.quoted?.text || '').trim().slice(0, 120);
      if (!text) {
        await ctx.reply(quote(`${bold('Usage:')} ${code(`${ctx.prefix}fancy <text>`)}`));
        return;
      }
      const rows = FANCY.map(([name, upper, lower, digit]) => `${italic(name)}\n${restyle(text, upper, lower, digit, name === 'Double')}`);
      await ctx.reply(`${card('✨', 'Fancy text', [])}\n\n${rows.join('\n\n')}`);
    }
  },
  {
    name: 'roll',
    aliases: ['dice'],
    category: 'fun',
    description: 'Roll a die (6 sides unless you say otherwise).',
    usage: 'roll [sides]',
    cooldown: 3,
    async execute(ctx) {
      const sides = Math.min(Math.max(Number.parseInt(ctx.args[0] ?? '6', 10) || 6, 2), 1_000_000);
      await ctx.reply(`🎲 ${randomInt(sides) + 1} (d${sides})`);
    }
  }
];
