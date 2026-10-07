import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ScheduledJob } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { JobInputSchema, scheduler } from '../scheduler/scheduler.js';
import { HttpError, asBadRequest, badRequest, notFound } from './http.js';

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

function serialize(job: ScheduledJob) {
  const { targets, progress, mediaPath, ...rest } = job;
  const targetList = JSON.parse(targets) as string[];
  return {
    ...rest,
    targets: targetList,
    delivered: progress ? (JSON.parse(progress) as string[]).length : 0,
    hasMedia: Boolean(mediaPath),
    nextRunAt: job.kind === 'recurring' && job.status === 'active' ? scheduler.nextRun(job.id) : job.nextAttemptAt
  };
}

async function requireJob(id: string): Promise<ScheduledJob> {
  const job = await prisma.scheduledJob.findUnique({ where: { id } });
  if (!job) throw notFound('Job not found.');
  return job;
}

/** Delete uploads that never got attached to a job (composer abandoned mid-way). */
export async function purgeOrphanUploads(): Promise<void> {
  const files = await readdir(config.paths.uploads).catch(() => [] as string[]);
  if (files.length === 0) return;
  const jobs = await prisma.scheduledJob.findMany({ where: { mediaPath: { not: null } }, select: { mediaPath: true } });
  const used = new Set(jobs.map(job => path.basename(job.mediaPath!)));
  for (const file of files) {
    if (used.has(file)) continue;
    const info = await stat(path.join(config.paths.uploads, file)).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > ORPHAN_AGE_MS) await rm(path.join(config.paths.uploads, file), { force: true });
  }
}

export function registerJobRoutes(app: FastifyInstance): void {
  app.get('/api/jobs', async () => {
    const jobs = await prisma.scheduledJob.findMany({ orderBy: { createdAt: 'desc' } });
    return jobs.map(serialize);
  });

  app.post('/api/jobs', async req => {
    const input = JobInputSchema.parse(req.body);
    return serialize(await asBadRequest(() => scheduler.create(input)));
  });

  app.put<{ Params: { id: string } }>('/api/jobs/:id', async req => {
    await requireJob(req.params.id);
    const input = JobInputSchema.parse(req.body);
    return serialize(await asBadRequest(() => scheduler.update(req.params.id, input)));
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async req => {
    await scheduler.remove(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string; action: string } }>('/api/jobs/:id/:action', async req => {
    const { id, action } = req.params;
    await requireJob(id);
    if (action === 'pause') return serialize(await scheduler.pause(id));
    if (action === 'resume') return serialize(await scheduler.resume(id));
    if (action === 'run') {
      await asBadRequest(() => scheduler.runNow(id));
      return { ok: true };
    }
    throw badRequest(`Unknown action "${action}".`);
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id/runs', async req =>
    prisma.jobRun.findMany({ where: { jobId: req.params.id }, orderBy: { startedAt: 'desc' }, take: 25 })
  );

  /** Attachment upload for the composer. Returns an id that a job can reference as `mediaId`. */
  app.post('/api/uploads', async req => {
    const file = await req.file();
    if (!file) throw badRequest('No file was uploaded.');
    const extension = path.extname(file.filename).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    // The stored name is generated here, so nothing from the client ever reaches the filesystem path.
    const id = `${randomUUID()}.${extension}`;
    const destination = path.join(config.paths.uploads, id);
    await pipeline(file.file, createWriteStream(destination));
    if (file.file.truncated) {
      await rm(destination, { force: true });
      throw new HttpError(413, `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    }
    const { size } = await stat(destination);
    return { id, name: file.filename, mime: file.mimetype, size };
  });
}
