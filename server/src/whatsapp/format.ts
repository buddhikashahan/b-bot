// Building blocks for WhatsApp-formatted messages, so every reply the bot
// sends uses the same visual language.
//
// WhatsApp markup: *bold*  _italic_  ~strike~  `inline code`  ```monospace```
//                  "> " block quote, "- " bullet list, "1. " numbered list.

type Row = string | false | null | undefined;

/** Markers only render when they hug the text, so trim before wrapping. */
const wrap = (marker: string, text: string | number) => {
  const value = String(text).trim();
  return value ? `${marker}${value}${marker}` : '';
};

export const bold = (text: string | number) => wrap('*', text);
export const italic = (text: string | number) => wrap('_', text);
export const strike = (text: string | number) => wrap('~', text);
export const code = (text: string | number) => wrap('`', text);
export const mono = (text: string | number) => wrap('```', text);

/** Block quote, one "> " per line. */
export function quote(text: string): string {
  return text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

export function bullets(items: Row[]): string {
  return items
    .filter((item): item is string => Boolean(item))
    .map(item => `- ${item}`)
    .join('\n');
}

export function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

/** "*Label:* value" */
export function field(label: string, value: string | number): string {
  return `${bold(`${label}:`)} ${value}`;
}

const CARD_END = '╰───────────────';

/**
 * A titled box, the bot's standard layout for anything with several facts:
 *
 *   ╭─「 🗑️ *Deleted message* 」
 *   │ 👤 *From:* ...
 *   ╰───────────────
 *
 * Falsy rows are skipped, so callers can write `condition && row`.
 */
export function card(icon: string, title: string, rows: Row[]): string {
  const body = rows
    .filter((row): row is string => Boolean(row))
    .flatMap(row => row.split('\n'))
    .map(line => `│ ${line}`);
  return [`╭─「 ${icon} ${bold(title)} 」`, ...body, CARD_END].join('\n');
}

/** A command as people type it, e.g. `.song`. */
export function command(prefix: string, name: string): string {
  return code(`${prefix}${name}`);
}

/** "> *Usage:* `.song <name or link>`", optionally with an example line. */
export function usage(prefix: string, pattern: string, example?: string): string {
  const lines = [`${bold('Usage:')} ${code(`${prefix}${pattern}`)}`];
  if (example) lines.push(`${bold('Example:')} ${code(`${prefix}${example}`)}`);
  return quote(lines.join('\n'));
}

export const ok = (text: string) => `✅ ${text}`;
export const fail = (text: string, detail?: string) => `❌ ${bold(text)}${detail ? `\n${quote(detail)}` : ''}`;
export const note = (text: string) => quote(italic(text));

/** "1h 5m 20s" */
export function duration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`, `${seconds % 60}s`].filter(Boolean).join(' ');
}

/** "3:07" or "1:02:45", the way media players show length. */
export function clock(totalSeconds: number | null | undefined): string {
  if (!totalSeconds || !Number.isFinite(totalSeconds)) return 'live';
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

/** "1.2M", "34K" */
export function compact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '?';
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** "12.4 MB" */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
