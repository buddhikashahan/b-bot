import { ArrowDownToLine, Eraser } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, PageHeader, Select, cx } from '../components/ui';
import { useLive } from '../lib/live';
import type { LogEntry } from '../lib/types';

const LEVEL_RANK: Record<LogEntry['level'], number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
const LEVEL_CLASS: Record<LogEntry['level'], string> = {
  trace: 'text-muted',
  debug: 'text-muted',
  info: 'text-accent',
  warn: 'text-warn',
  error: 'text-danger',
  fatal: 'text-danger font-semibold'
};

export function LogsPage() {
  const { logs, clearLogs, online } = useLive();
  const [minLevel, setMinLevel] = useState<LogEntry['level']>('info');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter(
      entry =>
        LEVEL_RANK[entry.level] >= LEVEL_RANK[minLevel] &&
        (!needle || entry.msg.toLowerCase().includes(needle) || entry.scope.toLowerCase().includes(needle))
    );
  }, [logs, minLevel, query]);

  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [visible, follow]);

  // Scrolling up pauses following; returning to the bottom resumes it.
  const onScroll = () => {
    const element = viewport.current;
    if (!element) return;
    setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Logs"
        description="Live output from the bot. Only the most recent lines are kept in the browser."
        actions={
          <>
            <span className="flex items-center gap-2 text-xs text-muted">
              <span className={cx('h-2 w-2 rounded-full', online ? 'bg-accent' : 'bg-danger')} />
              {online ? 'Live' : 'Offline'}
            </span>
            <Button size="sm" onClick={clearLogs} icon={<Eraser className="h-3.5 w-3.5" />}>
              Clear
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <Select aria-label="Minimum level" className="w-40" value={minLevel} onChange={event => setMinLevel(event.target.value as LogEntry['level'])}>
          <option value="debug">Debug and above</option>
          <option value="info">Info and above</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors only</option>
        </Select>
        <Input aria-label="Filter logs" className="max-w-xs flex-1" placeholder="Filter…" value={query} onChange={event => setQuery(event.target.value)} />
      </div>

      <div className="relative min-h-80 flex-1">
        <div
          ref={viewport}
          onScroll={onScroll}
          role="log"
          className="absolute inset-0 overflow-auto rounded-xl border border-line bg-panel p-3 font-mono text-xs leading-relaxed"
        >
          {visible.length === 0 ? (
            <p className="p-4 text-center font-sans text-sm text-muted">No log lines match.</p>
          ) : (
            visible.map(entry => (
              <div key={entry.id} className="flex gap-3 whitespace-pre-wrap">
                <span className="shrink-0 text-muted">{new Date(entry.time).toLocaleTimeString(undefined, { hour12: false })}</span>
                <span className={cx('w-11 shrink-0 uppercase', LEVEL_CLASS[entry.level])}>{entry.level}</span>
                <span className="min-w-0 break-words">
                  <span className="text-muted">[{entry.scope}]</span> {entry.msg}
                </span>
              </div>
            ))
          )}
        </div>
        {!follow && (
          <Button
            size="sm"
            variant="primary"
            className="absolute right-4 bottom-4 shadow-lg"
            onClick={() => setFollow(true)}
            icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
          >
            Jump to latest
          </Button>
        )}
      </div>
    </div>
  );
}
