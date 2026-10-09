import type {
  AnyMessageContent,
  GroupMetadata,
  WAMessage,
  WASocket,
  proto
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { Settings } from '../settings.js';
import type { BotSession } from '../whatsapp/session.js';

export type CommandCategory = 'general' | 'ai' | 'download' | 'info' | 'media' | 'utility' | 'admin' | 'fun' | 'adult';

export interface Command {
  name: string;
  aliases?: string[];
  category: CommandCategory;
  description: string;
  usage?: string;
  ownerOnly?: boolean;
  groupOnly?: boolean;
  /** Caller must be a group admin (owners always pass). Implies groupOnly. */
  adminOnly?: boolean;
  /** The bot itself must be a group admin for this to work. Implies groupOnly. */
  botAdmin?: boolean;
  cooldown?: number; // seconds
  execute: (ctx: CommandContext) => Promise<void>;
}

export interface QuotedMessage {
  /** A WAMessage reconstructed from the quote, usable with download/forward helpers. */
  message: WAMessage;
  content: proto.IMessage;
  sender: string;
  text: string;
}

export interface CommandContext {
  bot: BotSession;
  sock: WASocket;
  msg: WAMessage;
  /** Chat the command was sent in. */
  jid: string;
  /** Sender's JID (phone-number form when WhatsApp exposes it). */
  sender: string;
  senderIds: string[];
  senderName: string;
  isGroup: boolean;
  isOwner: boolean;
  /** Sender is an admin of this group. */
  isAdmin: boolean;
  isBotAdmin: boolean;
  group?: GroupMetadata;
  prefix: string;
  /** Name the command was invoked with (may be an alias). */
  command: string;
  args: string[];
  /** Everything after the command name, untouched. */
  text: string;
  /** JIDs @mentioned in the message. */
  mentions: string[];
  quoted?: QuotedMessage;
  settings: Settings;
  log: Logger;
  /** Reply in the same chat, quoting the triggering message. */
  reply: (content: string | AnyMessageContent) => Promise<WAMessage | undefined>;
  /** Send to the same chat without quoting. */
  send: (content: string | AnyMessageContent) => Promise<WAMessage | undefined>;
  react: (emoji: string) => Promise<void>;
}
