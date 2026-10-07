import { bus, type ActivityEntry, type ActivityType } from '../bus.js';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';

const log = scoped('activity');
const KEEP_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Record something the bot did, for the dashboard's activity feed and counters.
 * Never throws: bookkeeping must not break the feature that called it.
 */
export function recordActivity(
  sessionId: string,
  type: ActivityType,
  title: string,
  options: { detail?: string; chat?: string } = {}
): void {
  prisma.activityEvent
    .create({
      data: { sessionId, type, title: title.slice(0, 300), detail: options.detail?.slice(0, 1000) ?? null, chat: options.chat ?? null }
    })
    .then(row => {
      const entry: ActivityEntry = { ...row, type, createdAt: row.createdAt.toISOString() };
      bus.publish({ type: 'activity', data: entry });
    })
    .catch(err => log.warn({ err }, 'could not record activity'));
}

export async function recentActivity(sessionId: string, limit = 50, type?: string): Promise<ActivityEntry[]> {
  const rows = await prisma.activityEvent.findMany({
    where: { sessionId, ...(type ? { type } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200)
  });
  return rows.map(row => ({ ...row, type: row.type as ActivityType, createdAt: row.createdAt.toISOString() }));
}

/** Event counts per type for the last 24 hours and the last 7 days. */
export async function activityStats(sessionId: string): Promise<{ day: Record<string, number>; week: Record<string, number> }> {
  const count = async (since: Date) => {
    const groups = await prisma.activityEvent.groupBy({
      by: ['type'],
      where: { sessionId, createdAt: { gte: since } },
      _count: { _all: true }
    });
    return Object.fromEntries(groups.map(group => [group.type, group._count._all]));
  };
  const now = Date.now();
  const [day, week] = await Promise.all([count(new Date(now - DAY_MS)), count(new Date(now - 7 * DAY_MS))]);
  return { day, week };
}

export async function purgeOldActivity(): Promise<void> {
  await prisma.activityEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * DAY_MS) } } });
}
