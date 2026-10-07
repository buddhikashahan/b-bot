// Shapes returned by the B-Bot API (see server/src).

export type SessionStatus =
  | 'disconnected'
  | 'connecting'
  | 'awaiting_qr'
  | 'awaiting_pairing'
  | 'connected'
  | 'reconnecting';

export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  detail?: string;
  paired: boolean;
  method: 'qr' | 'pairing';
  authStore: 'file' | 'database';
  me?: { jid: string; phone: string; name?: string };
  qr?: { dataUrl: string; expiresAt: number; seq: number };
  pairing?: { code: string; phone: string; expiresAt: number };
  retry?: { attempt: number; nextAt: number };
  lastDisconnect?: { code?: number; reason: string; at: number };
  connectedAt?: number;
}

export interface LogEntry {
  id: number;
  time: number;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  scope: string;
  msg: string;
}

export type ChatScope = 'all' | 'private' | 'groups';

export interface AutoReplyRule {
  id: string;
  enabled: boolean;
  trigger: string;
  match: 'contains' | 'exact' | 'starts';
  response: string;
  scope: ChatScope;
}

export interface Settings {
  general: { ownerNumbers: string[]; alertTarget: string; markOnline: boolean; autoRead: boolean };
  commands: { enabled: boolean; prefix: string; mode: 'public' | 'private'; scope: ChatScope; disabled: string[] };
  access: { blockedUsers: string[]; blockedChats: string[] };
  antiDelete: {
    enabled: boolean;
    ttlHours: number;
    privateChats: boolean;
    groups: boolean;
    edits: boolean;
    cacheMedia: boolean;
    maxMediaMb: number;
  };
  viewOnce: { enabled: boolean; destination: 'alert' | 'chat'; onReply: boolean; notify: boolean };
  status: { autoView: boolean; forward: boolean };
  calls: { reject: boolean; message: string };
  autoReply: {
    enabled: boolean;
    rules: AutoReplyRule[];
    awayEnabled: boolean;
    awayMessage: string;
    awayCooldownMinutes: number;
  };
  ai: {
    enabled: boolean;
    model: string;
    fallbackModel: string;
    prompt: string;
    scope: ChatScope;
    groupTrigger: 'mention' | 'always';
    thinking: 'low' | 'medium' | 'high';
    images: boolean;
    historyMessages: number;
  };
  downloads: { enabled: boolean; ownerOnly: boolean; maxSizeMb: number; maxMinutes: number };
  groups: { defaultWelcome: string; defaultFarewell: string };
  broadcast: { minDelayMs: number; maxDelayMs: number };
}

export type ActivityType =
  | 'deleted'
  | 'edited'
  | 'viewonce'
  | 'status'
  | 'antilink'
  | 'call'
  | 'command'
  | 'autoreply'
  | 'ai'
  | 'menu'
  | 'job'
  | 'member';

export interface ActivityEntry {
  id: string;
  type: ActivityType;
  title: string;
  detail: string | null;
  chat: string | null;
  createdAt: string;
}

export interface Overview {
  stats: { day: Partial<Record<ActivityType, number>>; week: Partial<Record<ActivityType, number>> };
  aiConfigured: boolean;
  counts: { cachedMessages: number; contacts: number; activeJobs: number; groups: number; managedGroups: number; menus: number };
  uptimeSeconds: number;
}

export interface AuthStatus {
  authenticated: boolean;
  setupRequired: boolean;
  managedByEnv: boolean;
  minPasswordLength: number;
}

export interface TargetList {
  groups: { jid: string; name: string; size: number }[];
  contacts: { jid: string; name: string }[];
}

export interface GroupConfig {
  jid: string;
  name: string;
  size: number;
  botIsAdmin: boolean;
  antiLink: boolean;
  antiLinkMode: 'whatsapp' | 'all';
  antiLinkAction: 'delete' | 'warn' | 'kick';
  warnLimit: number;
  whitelist: string[];
  welcomeEnabled: boolean;
  welcomeTemplate: string;
  farewellEnabled: boolean;
  farewellTemplate: string;
}

export type JobStatus = 'pending' | 'active' | 'running' | 'paused' | 'completed' | 'failed';

export interface Job {
  id: string;
  name: string;
  kind: 'once' | 'recurring';
  cron: string | null;
  timezone: string | null;
  runAt: string | null;
  targets: string[];
  delivered: number;
  text: string | null;
  hasMedia: boolean;
  mediaName: string | null;
  mediaMime: string | null;
  status: JobStatus;
  attempts: number;
  maxRetries: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  runCount: number;
  createdAt: string;
}

export interface JobRun {
  id: string;
  attempt: number;
  status: 'running' | 'completed' | 'failed';
  sent: number;
  failed: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Upload {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface CommandInfo {
  name: string;
  aliases?: string[];
  category: 'general' | 'ai' | 'download' | 'info' | 'media' | 'utility' | 'admin' | 'fun';
  description: string;
  usage?: string;
  ownerOnly?: boolean;
  groupOnly?: boolean;
  adminOnly?: boolean;
  cooldown?: number;
  source: 'builtin' | 'plugin';
  enabled: boolean;
}

export interface AiStatus {
  /** An API key is saved on the server. The key itself is never sent back. */
  configured: boolean;
  /** Last characters of the key, to recognise which one is in use. */
  keyHint: string | null;
  lastError: { message: string; at: number } | null;
  lastReplyAt: number | null;
  lastModel: string | null;
  /** Shown while the backup model is standing in for the main one. */
  notice: string | null;
}

export interface CustomMenuOption {
  label: string;
  type: 'text' | 'menu' | 'command';
  value: string;
}

export interface CustomMenu {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  match: 'exact' | 'contains' | 'starts';
  scope: ChatScope;
  title: string;
  body: string;
  options: CustomMenuOption[];
}

export interface DownloaderStatus {
  ytDlpVersion: string | null;
  ffmpeg: boolean;
  cookies: boolean;
  supported: boolean;
}

export interface SystemInfo {
  version: string;
  node: string;
  platform: string;
  uptimeSeconds: number;
  authStore: 'file' | 'database';
  supervised: boolean;
  database: {
    provider: string;
    source: 'env' | 'config' | 'default';
    url: string;
    error?: string;
    rejectedUrl?: string;
  };
  stats: { cachedMessages: number; contacts: number; jobs: number };
}
