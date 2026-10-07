import { useMemo, useState } from 'react';
import { ACTIVITY, ActivityList } from '../components/shared';
import { Card, Empty, PageHeader, cx } from '../components/ui';
import { useLive } from '../lib/live';
import type { ActivityType } from '../lib/types';

export function ActivityPage() {
  const { activity, online } = useLive();
  const [filter, setFilter] = useState<ActivityType | 'all'>('all');

  const counts = useMemo(() => {
    const map = new Map<ActivityType, number>();
    for (const entry of activity) map.set(entry.type, (map.get(entry.type) ?? 0) + 1);
    return map;
  }, [activity]);
  const visible = filter === 'all' ? activity : activity.filter(entry => entry.type === filter);
  const types = (Object.keys(ACTIVITY) as ActivityType[]).filter(type => counts.has(type));

  const chip = (value: ActivityType | 'all', label: string, count: number) => (
    <button
      key={value}
      type="button"
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
      className={cx(
        'rounded-full border px-3 py-1 text-sm transition-colors',
        filter === value ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-panel text-muted hover:text-ink'
      )}
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );

  return (
    <>
      <PageHeader
        title="Activity"
        description="Everything the bot has done recently. Updates live; entries are kept for 14 days."
        actions={
          <span className="flex items-center gap-2 text-xs text-muted">
            <span className={cx('h-2 w-2 rounded-full', online ? 'bg-accent' : 'bg-danger')} />
            {online ? 'Live' : 'Offline'}
          </span>
        }
      />

      {activity.length === 0 ? (
        <Empty title="No activity yet" hint="Turn on a feature such as anti-delete or auto-replies; what the bot does will be listed here." />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {chip('all', 'All', activity.length)}
            {types.map(type => chip(type, ACTIVITY[type].label, counts.get(type) ?? 0))}
          </div>
          <Card>
            <div className="-my-3">
              <ActivityList entries={visible} />
            </div>
          </Card>
          {activity.length >= 200 && <p className="text-center text-xs text-muted">Showing the 200 most recent entries.</p>}
        </div>
      )}
    </>
  );
}
