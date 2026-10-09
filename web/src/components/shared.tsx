import {
  CalendarClock,
  Eye,
  Link2Off,
  ListOrdered,
  Megaphone,
  MessageSquareReply,
  Newspaper,
  Pencil,
  PhoneOff,
  Search,
  Sparkles,
  SquareTerminal,
  Trash2,
  UserPlus,
  type LucideIcon
} from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { useNow } from '../lib/live';
import type { ActivityEntry, ActivityType } from '../lib/types';
import { cx, relativeTime } from './ui';

export const ACTIVITY: Record<ActivityType, { label: string; icon: LucideIcon; tone: string }> = {
  deleted: { label: 'Deleted messages', icon: Trash2, tone: 'bg-danger-soft text-danger' },
  edited: { label: 'Edits', icon: Pencil, tone: 'bg-warn-soft text-warn' },
  viewonce: { label: 'View-once', icon: Eye, tone: 'bg-accent-soft text-accent' },
  status: { label: 'Statuses', icon: Megaphone, tone: 'bg-accent-soft text-accent' },
  antilink: { label: 'Links removed', icon: Link2Off, tone: 'bg-danger-soft text-danger' },
  call: { label: 'Calls', icon: PhoneOff, tone: 'bg-warn-soft text-warn' },
  command: { label: 'Commands', icon: SquareTerminal, tone: 'bg-raised text-muted' },
  autoreply: { label: 'Auto-replies', icon: MessageSquareReply, tone: 'bg-accent-soft text-accent' },
  ai: { label: 'AI answers', icon: Sparkles, tone: 'bg-accent-soft text-accent' },
  menu: { label: 'Menus', icon: ListOrdered, tone: 'bg-raised text-muted' },
  job: { label: 'Scheduled', icon: CalendarClock, tone: 'bg-raised text-muted' },
  member: { label: 'Members', icon: UserPlus, tone: 'bg-raised text-muted' },
  news: { label: 'News alerts', icon: Newspaper, tone: 'bg-accent-soft text-accent' }
};

/** Inline WhatsApp markup: ```mono```, `code`, *bold*, _italic_, ~strike~. */
function inline(text: string) {
  const parts = text.split(/(```[\s\S]+?```|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return parts.map((part, index) => {
    if (part.length > 6 && part.startsWith('```') && part.endsWith('```')) return <code key={index} className="font-mono text-[0.9em]">{part.slice(3, -3)}</code>;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={index} className="rounded bg-panel/60 px-1 font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) return <strong key={index}>{part.slice(1, -1)}</strong>;
    if (part.length > 2 && part.startsWith('_') && part.endsWith('_')) return <em key={index}>{part.slice(1, -1)}</em>;
    if (part.length > 2 && part.startsWith('~') && part.endsWith('~')) return <s key={index}>{part.slice(1, -1)}</s>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

/** Show text the way WhatsApp would render it, including "> " quote lines. Use inside a `whitespace-pre-wrap` box. */
export function WhatsAppText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, index) =>
        line.startsWith('> ') ? (
          <span key={index} className="block border-l-2 border-accent/60 pl-2 text-muted">
            {inline(line.slice(2))}
          </span>
        ) : (
          <span key={index} className="block min-h-[1.25em]">
            {inline(line)}
          </span>
        )
      )}
    </>
  );
}

export function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  const now = useNow(30_000);
  return (
    <ul className="divide-y divide-line">
      {entries.map(entry => {
        const meta = ACTIVITY[entry.type] ?? ACTIVITY.command;
        return (
          <li key={entry.id} className="flex items-start gap-3 py-3">
            <span className={cx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', meta.tone)}>
              <meta.icon className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm break-words">{entry.title}</p>
              {entry.detail && <p className="mt-0.5 line-clamp-2 text-sm break-words text-muted">{entry.detail}</p>}
            </div>
            <time dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()} className="shrink-0 pt-0.5 text-xs whitespace-nowrap text-muted">
              {relativeTime(entry.createdAt, now)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}

/** Type-to-search list for picking a contact or group that WhatsApp has synced. */
export function ChatSearch({
  items,
  onPick,
  placeholder,
  exclude
}: {
  items: { jid: string; name: string; detail?: string }[];
  onPick: (jid: string) => void;
  placeholder: string;
  exclude?: string[];
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const skip = new Set(exclude);
    return items.filter(item => !skip.has(item.jid) && (item.name.toLowerCase().includes(needle) || item.jid.includes(needle))).slice(0, 6);
  }, [items, query, exclude]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-muted" aria-hidden />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={query}
        onChange={event => setQuery(event.target.value)}
        className="h-10 w-full rounded-lg border border-line bg-panel pr-3 pl-9 text-sm placeholder:text-muted/70 focus:border-accent focus:outline-none"
      />
      {query.trim() && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-line bg-panel shadow-lg">
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">No match among synced chats.</li>
          ) : (
            matches.map(item => (
              <li key={item.jid}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(item.jid);
                    setQuery('');
                  }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-raised"
                >
                  <span className="truncate">{item.name}</span>
                  {item.detail && <span className="shrink-0 text-xs text-muted">{item.detail}</span>}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
