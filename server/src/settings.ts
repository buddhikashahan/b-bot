import { z } from 'zod';
import { bus } from './bus.js';
import { prisma } from './db.js';
import { scoped } from './logger.js';

const log = scoped('settings');

export const DEFAULT_WELCOME = 'Welcome {user} to *{group}*! 👋\n\n{desc}';
export const DEFAULT_FAREWELL = 'Goodbye {user}. 👋';
export const DEFAULT_CALL_MESSAGE = "📵 Sorry, I can't take calls on this number. Please send a message instead.";
export const DEFAULT_AI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_AI_BACKUP_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_AWAY_MESSAGE = "👋 I'm away right now and will reply as soon as I can.";

const PhoneNumber = z.string().regex(/^\d{6,16}$/);
const ChatScope = z.enum(['all', 'private', 'groups']);

export const AutoReplyRuleSchema = z.object({
  id: z.string().min(1).max(40),
  enabled: z.boolean().default(true),
  /** Text to look for, compared case-insensitively. */
  trigger: z.string().trim().min(1).max(200),
  match: z.enum(['contains', 'exact', 'starts']).default('contains'),
  response: z.string().trim().min(1).max(4000),
  scope: ChatScope.default('all')
});
export type AutoReplyRule = z.infer<typeof AutoReplyRuleSchema>;

export const SettingsSchema = z.object({
  general: z
    .object({
      /** Extra owner phone numbers (digits only). The linked account itself is always an owner. */
      ownerNumbers: z.array(PhoneNumber).max(20).default([]),
      /** "owner" = the bot's own "Message yourself" chat, otherwise a user or group JID. */
      alertTarget: z.string().min(1).max(80).default('owner'),
      markOnline: z.boolean().default(false),
      /** Send read receipts (blue ticks) for every incoming message. */
      autoRead: z.boolean().default(false)
    })
    .prefault({}),
  commands: z.preprocess(
    // Before 0.2 this section had `public: boolean` instead of `mode`.
    value => {
      const section = value as { public?: boolean; mode?: string } | undefined;
      return section && section.mode === undefined && section.public === false ? { ...section, mode: 'private' } : value;
    },
    z
      .object({
        enabled: z.boolean().default(true),
        prefix: z.string().min(1).max(3).default('.'),
        /** public: anyone may use commands. private: owners only. */
        mode: z.enum(['public', 'private']).default('public'),
        /** Which chats commands work in. Owners are never restricted by this. */
        scope: ChatScope.default('all'),
        disabled: z.array(z.string()).default([])
      })
      .prefault({})
  ),
  access: z
    .object({
      /** Phone numbers the bot never responds to (commands and auto-replies). */
      blockedUsers: z.array(PhoneNumber).max(500).default([]),
      /** Group JIDs where the bot stays completely silent and inactive. */
      blockedChats: z.array(z.string().regex(/^[\d-]{5,40}@g\.us$/)).max(500).default([])
    })
    .prefault({}),
  antiDelete: z
    .object({
      enabled: z.boolean().default(false),
      ttlHours: z.number().int().min(1).max(48).default(24),
      privateChats: z.boolean().default(true),
      groups: z.boolean().default(true),
      /** Also report edits, showing the text before and after. */
      edits: z.boolean().default(true),
      cacheMedia: z.boolean().default(true),
      maxMediaMb: z.number().int().min(1).max(100).default(16)
    })
    .prefault({}),
  viewOnce: z
    .object({
      enabled: z.boolean().default(false),
      /** "alert" forwards to the alert target, "chat" re-sends into the original chat. */
      destination: z.enum(['alert', 'chat']).default('alert'),
      /** Reveal a view-once message as soon as anyone replies to it (the reply carries the media keys). */
      onReply: z.boolean().default(true),
      /** Tell the alert chat when a view-once arrives that WhatsApp did not deliver to this device. */
      notify: z.boolean().default(true)
    })
    .prefault({}),
  status: z
    .object({
      autoView: z.boolean().default(false),
      forward: z.boolean().default(false)
    })
    .prefault({}),
  calls: z
    .object({
      /** Decline incoming calls automatically. */
      reject: z.boolean().default(false),
      /** Text sent to the caller after declining; empty sends nothing. */
      message: z.string().max(1000).default(DEFAULT_CALL_MESSAGE)
    })
    .prefault({}),
  autoReply: z
    .object({
      enabled: z.boolean().default(false),
      rules: z.array(AutoReplyRuleSchema).max(100).default([]),
      /** Away message: one reply per private chat, at most once per cooldown. */
      awayEnabled: z.boolean().default(false),
      awayMessage: z.string().max(2000).default(DEFAULT_AWAY_MESSAGE),
      awayCooldownMinutes: z.number().int().min(1).max(10_080).default(240)
    })
    .prefault({}),
  ai: z
    .object({
      /** Answer ordinary messages (anything that is not a command) with the AI model. Needs an API key. */
      enabled: z.boolean().default(false),
      model: z.string().trim().min(1).max(80).regex(/^[\w.-]+$/).default(DEFAULT_AI_MODEL),
      /**
       * Used when the main model is overloaded or too slow. Google's newest models are often
       * at capacity; the lite model almost always answers. Empty disables the backup.
       */
      fallbackModel: z.string().trim().max(80).regex(/^[\w.-]*$/).default(DEFAULT_AI_BACKUP_MODEL),
      /** The owner's own instructions: who the assistant is and how it should answer. Empty uses the built-in one. */
      prompt: z.string().max(6000).default(''),
      /** Which chats get automatic answers. */
      scope: ChatScope.default('private'),
      /** In groups: answer only when mentioned or replied to, or answer everything. */
      groupTrigger: z.enum(['mention', 'always']).default('mention'),
      /**
       * How long the model reasons before answering. Gemini 3 models think by default;
       * "low" keeps chat replies quick, "high" is slower but better at hard questions.
       */
      thinking: z.enum(['low', 'medium', 'high']).default('low'),
      /** Look at photos people send. */
      images: z.boolean().default(true),
      /** How many of the latest messages of a chat are sent along as context. 0 = no memory. */
      historyMessages: z.number().int().min(0).max(40).default(12)
    })
    .prefault({}),
  downloads: z
    .object({
      /** Media download commands (song, video, fb, tiktok...). */
      enabled: z.boolean().default(true),
      /** Restrict them to owners; downloads use bandwidth and disk on this machine. */
      ownerOnly: z.boolean().default(false),
      maxSizeMb: z.number().int().min(5).max(500).default(60),
      maxMinutes: z.number().int().min(1).max(240).default(30)
    })
    .prefault({}),
  groups: z
    .object({
      defaultWelcome: z.string().max(2000).default(DEFAULT_WELCOME),
      defaultFarewell: z.string().max(2000).default(DEFAULT_FAREWELL)
    })
    .prefault({}),
  broadcast: z
    .object({
      /** Random pause between recipients, to stay well clear of WhatsApp's spam heuristics. */
      minDelayMs: z.number().int().min(500).max(60_000).default(2000),
      maxDelayMs: z.number().int().min(500).max(120_000).default(5000)
    })
    .prefault({})
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> };

// Rows whose key starts with this prefix are private server state, never sent to the dashboard.
const INTERNAL_PREFIX = '_';

let current: Settings = SettingsSchema.parse({});

export function getSettings(): Settings {
  return current;
}

export async function loadSettings(): Promise<Settings> {
  const rows = await prisma.setting.findMany();
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.key.startsWith(INTERNAL_PREFIX)) continue;
    try {
      raw[row.key] = JSON.parse(row.value);
    } catch {
      log.warn(`ignoring unreadable setting "${row.key}"`);
    }
  }
  const parsed = SettingsSchema.safeParse(raw);
  if (parsed.success) {
    current = parsed.data;
  } else {
    // Fall back section by section so one bad value doesn't reset everything.
    const repaired: Record<string, unknown> = {};
    for (const key of Object.keys(SettingsSchema.shape) as (keyof Settings)[]) {
      const section = SettingsSchema.shape[key].safeParse(raw[key]);
      if (section.success) repaired[key] = section.data;
      else log.warn(`setting section "${key}" was invalid and has been reset to defaults`);
    }
    current = SettingsSchema.parse(repaired);
  }
  return current;
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const merged: Record<string, unknown> = { ...current };
  const changed: (keyof Settings)[] = [];
  for (const key of Object.keys(SettingsSchema.shape) as (keyof Settings)[]) {
    if (patch[key] === undefined) continue;
    merged[key] = { ...current[key], ...patch[key] };
    changed.push(key);
  }
  const next = SettingsSchema.parse(merged);
  if (next.broadcast.maxDelayMs < next.broadcast.minDelayMs) {
    next.broadcast.maxDelayMs = next.broadcast.minDelayMs;
  }
  for (const key of changed) {
    const value = JSON.stringify(next[key]);
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  current = next;
  bus.publish({ type: 'settings', data: current });
  return current;
}

export async function getInternal(key: string): Promise<string | undefined> {
  const row = await prisma.setting.findUnique({ where: { key: INTERNAL_PREFIX + key } });
  return row?.value;
}

export async function setInternal(key: string, value: string): Promise<void> {
  const fullKey = INTERNAL_PREFIX + key;
  await prisma.setting.upsert({ where: { key: fullKey }, create: { key: fullKey, value }, update: { value } });
}
