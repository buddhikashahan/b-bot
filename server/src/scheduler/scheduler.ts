import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { ScheduledJob } from '@prisma/client';
import cron, { type ScheduledTask } from 'node-cron';
import { z } from 'zod';
import { bus } from '../bus.js';
import { config, DEFAULT_SESSION_ID } from '../config.js';
import { prisma } from '../db.js';
import { purgeOldActivity, recordActivity } from '../features/activity.js';
import { purgeOldMemory } from '../features/ai.js';
import { purgeExpiredPrompts } from '../features/menus.js';
import { purgeExpiredMessages } from '../features/anti-delete.js';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import { kindFromMime, mediaContent, phoneToJid, supportsCaption } from '../whatsapp/message-utils.js';
import { sessions } from '../whatsapp/session-manager.js';
import type { BotSession } from '../whatsapp/session.js';

const log = scoped('scheduler');

const TICK_MS = 15_000;
const PURGE_MS = 10 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
const UPLOAD_ID = /^[\w-]+\.[a-z0-9]{1,8}$/i;

/**
 * Job status:
 *   once       pending -> running -> completed | failed     (cancelled / paused by the user)
 *   recurring  active (fires on its cron) <-> paused
 * `nextAttemptAt` is when the tick loop should next pick the job up: the run
 * time of a one-off job, or the retry time after a failed attempt.
 */
export type JobStatus = 'pending' | 'active' | 'running' | 'paused' | 'completed' | 'failed';

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Accepts a JID or a bare phone number and returns a sendable JID. */
export function normalizeTarget(value: string): string | undefined {
  const target = value.trim();
  if (/^\d{5,20}@s\.whatsapp\.net$/.test(target) || /^[\d-]{5,40}@g\.us$/.test(target) || /^\d{5,20}@lid$/.test(target)) {
    return target;
  }
  const digits = target.replace(/[\s()+-]/g, '');
  return /^\d{7,15}$/.test(digits) ? phoneToJid(digits) : undefined;
}

export const JobInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['once', 'recurring']),
    runAt: z.coerce.date().optional(),
    cron: z.string().trim().max(100).optional(),
    timezone: z.string().trim().max(60).optional(),
    targets: z.array(z.string()).min(1).max(500),
    text: z.string().max(60_000).optional(),
    /** File id returned by POST /api/uploads; null removes the attachment. */
    mediaId: z.string().regex(UPLOAD_ID).nullish(),
    mediaName: z.string().max(255).optional(),
    mediaMime: z.string().max(120).optional(),
    maxRetries: z.number().int().min(0).max(10).default(3)
  })
  .superRefine((job, ctx) => {
    if (job.kind === 'once' && !job.runAt) ctx.addIssue({ code: 'custom', path: ['runAt'], message: 'Pick a date and time.' });
    if (job.kind === 'recurring' && (!job.cron || !cron.validate(job.cron))) {
      ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Enter a valid cron expression (e.g. "0 9 * * 1-5").' });
    }
    if (job.timezone && !isValidTimezone(job.timezone)) {
      ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'Unknown timezone.' });
    }
    if (job.targets.some(target => !normalizeTarget(target))) {
      ctx.addIssue({ code: 'custom', path: ['targets'], message: 'One or more recipients are not valid numbers or chat IDs.' });
    }
  });

export type JobInput = z.infer<typeof JobInputSchema>;

function parseList(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function retryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class Scheduler {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly running = new Set<string>();
  private tickTimer?: NodeJS.Timeout;
  private purgeTimer?: NodeJS.Timeout;
  private stopped = true;

  async start(): Promise<void> {
    this.stopped = false;
    // Anything still "running" was interrupted by a crash or restart. Its
    // delivery progress is on the row, so resuming only reaches the remaining targets.
    const interrupted = await prisma.scheduledJob.updateMany({
      where: { status: 'running' },
      data: { status: 'pending', nextAttemptAt: new Date() }
    });
    if (interrupted.count) log.warn(`resuming ${interrupted.count} job(s) interrupted by the last shutdown`);
    await prisma.jobRun.updateMany({
      where: { status: 'running' },
      data: { status: 'failed', error: 'Interrupted by a restart', finishedAt: new Date() }
    });

    const recurring = await prisma.scheduledJob.findMany({ where: { kind: 'recurring', status: 'active' } });
    for (const job of recurring) this.register(job);
    log.info(`started with ${recurring.length} recurring job(s)`);

    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    const purge = () => {
      void purgeExpiredMessages().catch(() => {});
      void purgeOldActivity().catch(() => {});
      void purgeOldMemory().catch(() => {});
      void purgeExpiredPrompts().catch(() => {});
    };
    this.purgeTimer = setInterval(purge, PURGE_MS);
    void this.tick();
    purge();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.tickTimer);
    clearInterval(this.purgeTimer);
    for (const task of this.tasks.values()) await task.destroy();
    this.tasks.clear();
  }

  // --- CRUD --------------------------------------------------------------------------------

  private toData(input: JobInput) {
    const once = input.kind === 'once';
    return {
      name: input.name,
      kind: input.kind,
      runAt: once ? input.runAt! : null,
      cron: once ? null : input.cron!,
      timezone: input.timezone || null,
      targets: JSON.stringify([...new Set(input.targets.map(normalizeTarget).filter(Boolean))]),
      text: input.text?.trim() || null,
      maxRetries: input.maxRetries,
      status: once ? 'pending' : 'active',
      nextAttemptAt: once ? input.runAt! : null,
      attempts: 0,
      progress: null,
      lastError: null
    };
  }

  private mediaData(input: JobInput) {
    if (input.mediaId === undefined) return {};
    if (input.mediaId === null) return { mediaPath: null, mediaName: null, mediaMime: null };
    return {
      mediaPath: path.join(config.paths.uploads, input.mediaId),
      mediaName: input.mediaName || input.mediaId,
      mediaMime: input.mediaMime || 'application/octet-stream'
    };
  }

  /** A job needs something to send; on update, an attachment it already has counts. */
  private assertHasContent(input: JobInput, existingMedia = false): void {
    const hasMedia = input.mediaId === undefined ? existingMedia : input.mediaId !== null;
    if (!input.text?.trim() && !hasMedia) throw new Error('Write a message or attach a file.');
  }

  async create(input: JobInput, sessionId = DEFAULT_SESSION_ID): Promise<ScheduledJob> {
    this.assertHasContent(input);
    const job = await prisma.scheduledJob.create({
      data: { sessionId, ...this.toData(input), ...this.mediaData(input) }
    });
    this.register(job);
    this.changed('created');
    return job;
  }

  async update(id: string, input: JobInput): Promise<ScheduledJob> {
    const previous = await prisma.scheduledJob.findUniqueOrThrow({ where: { id } });
    this.assertHasContent(input, Boolean(previous.mediaPath));
    const media = this.mediaData(input);
    const job = await prisma.scheduledJob.update({ where: { id }, data: { ...this.toData(input), ...media } });
    if ('mediaPath' in media && previous.mediaPath && previous.mediaPath !== job.mediaPath) {
      await rm(previous.mediaPath, { force: true });
    }
    this.register(job);
    this.changed('updated');
    return job;
  }

  async remove(id: string): Promise<void> {
    const job = await prisma.scheduledJob.findUnique({ where: { id } });
    if (!job) return;
    await this.unregister(id);
    await prisma.jobRun.deleteMany({ where: { jobId: id } });
    await prisma.scheduledJob.delete({ where: { id } });
    if (job.mediaPath) await rm(job.mediaPath, { force: true });
    this.changed('deleted');
  }

  async pause(id: string): Promise<ScheduledJob> {
    await this.unregister(id);
    const job = await prisma.scheduledJob.update({ where: { id }, data: { status: 'paused' } });
    this.changed('paused');
    return job;
  }

  async resume(id: string): Promise<ScheduledJob> {
    const current = await prisma.scheduledJob.findUniqueOrThrow({ where: { id } });
    const once = current.kind === 'once';
    const job = await prisma.scheduledJob.update({
      where: { id },
      data: {
        status: once ? 'pending' : 'active',
        attempts: 0,
        lastError: null,
        nextAttemptAt: once ? (current.nextAttemptAt ?? current.runAt ?? new Date()) : null
      }
    });
    this.register(job);
    this.changed('resumed');
    return job;
  }

  /** Send right now, regardless of schedule. */
  async runNow(id: string): Promise<void> {
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { id } });
    if (this.running.has(id)) throw new Error('This job is already running.');
    if (!sessions.get(job.sessionId)?.connected) throw new Error('WhatsApp is not connected.');
    if (job.kind === 'recurring' && job.status !== 'active') throw new Error('Resume this job before running it.');
    await prisma.scheduledJob.update({
      where: { id },
      // A finished one-off job goes back to pending so it can be sent again.
      data: { attempts: 0, progress: null, ...(job.kind === 'once' ? { status: 'pending' } : {}) }
    });
    void this.execute(id);
  }

  nextRun(id: string): Date | null {
    return this.tasks.get(id)?.getNextRun() ?? null;
  }

  // --- execution ---------------------------------------------------------------------------

  private register(job: ScheduledJob): void {
    void this.unregister(job.id);
    if (this.stopped || job.kind !== 'recurring' || job.status !== 'active' || !job.cron) return;
    const task = cron.schedule(job.cron, () => void this.onCronFire(job.id), {
      timezone: job.timezone ?? undefined,
      name: job.id
    });
    this.tasks.set(job.id, task);
  }

  private async unregister(id: string): Promise<void> {
    const task = this.tasks.get(id);
    this.tasks.delete(id);
    await task?.destroy();
  }

  private async onCronFire(id: string): Promise<void> {
    if (this.running.has(id)) return;
    // A new occurrence supersedes any retry still pending from the previous one.
    await prisma.scheduledJob
      .updateMany({ where: { id, status: 'active' }, data: { attempts: 0, progress: null, nextAttemptAt: null } })
      .catch(err => log.error({ err }, 'could not reset recurring job'));
    await this.execute(id);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const due = await prisma.scheduledJob.findMany({
        where: { status: { in: ['pending', 'active'] }, nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: 'asc' },
        take: 20
      });
      for (const job of due) await this.execute(job.id);
    } catch (err) {
      log.error({ err }, 'tick failed');
    }
  }

  private async execute(id: string): Promise<void> {
    if (this.running.has(id) || this.stopped) return;
    this.running.add(id);
    try {
      const job = await prisma.scheduledJob.findUnique({ where: { id } });
      if (!job || (job.status !== 'pending' && job.status !== 'active')) return;
      const bot = sessions.get(job.sessionId);

      if (!bot?.connected) {
        // Not an attempt: stay due and go out as soon as the connection is back.
        if (!job.nextAttemptAt) await prisma.scheduledJob.update({ where: { id }, data: { nextAttemptAt: new Date() } });
        return;
      }
      await this.deliver(bot, job);
    } catch (err) {
      log.error({ err }, `job ${id} crashed`);
    } finally {
      this.running.delete(id);
      this.changed('run');
    }
  }

  private async deliver(bot: BotSession, job: ScheduledJob): Promise<void> {
    const recurring = job.kind === 'recurring';
    const idleStatus: JobStatus = recurring ? 'active' : 'pending';
    const targets = parseList(job.targets);
    const delivered = new Set(parseList(job.progress));
    const attempt = job.attempts + 1;

    if (!recurring) await prisma.scheduledJob.update({ where: { id: job.id }, data: { status: 'running' } });
    const run = await prisma.jobRun.create({ data: { jobId: job.id, attempt, status: 'running' } });
    this.changed('started');

    const { minDelayMs, maxDelayMs } = getSettings().broadcast;
    const errors: string[] = [];
    let sent = 0;
    const pending = targets.filter(target => !delivered.has(target));
    for (const [index, target] of pending.entries()) {
      try {
        await this.sendTo(bot, job, target);
        delivered.add(target);
        sent++;
        await prisma.scheduledJob.update({ where: { id: job.id }, data: { progress: JSON.stringify([...delivered]) } });
      } catch (err) {
        errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
        if (!bot.connected) break;
      }
      if (index < pending.length - 1) await sleep(minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs));
    }

    const remaining = targets.length - delivered.size;
    const error = errors.length ? errors.slice(0, 20).join('\n') : null;
    const finished = { finishedAt: new Date(), sent, failed: remaining, error };

    if (remaining === 0) {
      await prisma.jobRun.update({ where: { id: run.id }, data: { ...finished, status: 'completed' } });
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: {
          status: recurring ? 'active' : 'completed',
          attempts: 0,
          progress: null,
          nextAttemptAt: null,
          lastError: null,
          lastRunAt: new Date(),
          runCount: { increment: 1 }
        }
      });
      log.info(`job "${job.name}" delivered to ${targets.length} recipient(s)`);
      recordActivity(job.sessionId, 'job', `Sent "${job.name}" to ${targets.length} recipient${targets.length === 1 ? '' : 's'}`);
      return;
    }

    await prisma.jobRun.update({ where: { id: run.id }, data: { ...finished, status: 'failed' } });
    if (attempt <= job.maxRetries) {
      const delay = retryDelay(attempt);
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: { status: idleStatus, attempts: attempt, nextAttemptAt: new Date(Date.now() + delay), lastError: error }
      });
      log.warn(`job "${job.name}": ${remaining} recipient(s) failed, retry ${attempt}/${job.maxRetries} in ${Math.round(delay / 1000)}s`);
    } else {
      // Out of retries. A recurring job stays active and starts clean at its next occurrence.
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: {
          status: recurring ? 'active' : 'failed',
          attempts: 0,
          progress: null,
          nextAttemptAt: null,
          lastError: error,
          lastRunAt: new Date()
        }
      });
      log.error(`job "${job.name}" gave up after ${attempt} attempt(s); ${remaining} recipient(s) not reached`);
      recordActivity(job.sessionId, 'job', `"${job.name}" failed for ${remaining} recipient${remaining === 1 ? '' : 's'}`, {
        detail: error ?? undefined
      });
    }
  }

  private async sendTo(bot: BotSession, job: ScheduledJob, target: string): Promise<void> {
    const text = job.text ?? undefined;
    if (!job.mediaPath) {
      await bot.send(target, { text: text ?? '' });
      return;
    }
    const mime = job.mediaMime ?? 'application/octet-stream';
    const info = { kind: kindFromMime(mime), mime, fileName: job.mediaName ?? undefined };
    const source = { url: job.mediaPath };
    if (supportsCaption(info.kind)) {
      await bot.send(target, mediaContent(info, source, text));
    } else {
      await bot.send(target, mediaContent(info, source));
      if (text) await bot.send(target, { text });
    }
  }

  private changed(reason: string): void {
    bus.publish({ type: 'jobs', data: { reason } });
  }
}

export const scheduler = new Scheduler();
