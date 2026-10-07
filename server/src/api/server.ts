import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { SESSION_COOKIE, verifyToken } from '../auth/dashboard-auth.js';
import { bus, type LiveEvent } from '../bus.js';
import { config } from '../config.js';
import { recentLogs, scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import { sessions } from '../whatsapp/session-manager.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerBotRoutes } from './bot-routes.js';
import { MAX_UPLOAD_BYTES, registerJobRoutes } from './job-routes.js';
import { registerSystemRoutes } from './system-routes.js';

const log = scoped('http');
const PUBLIC_API = new Set(['/api/health']);
/** Stop queueing live events for a dashboard tab that has stopped reading. */
const MAX_WS_BACKLOG_BYTES = 1024 * 1024;
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'"
].join('; ');

function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (error instanceof ZodError) {
      const message = error.issues.map(issue => (issue.path.length ? `${issue.path.join('.')}: ` : '') + issue.message).join(' ');
      return reply.code(400).send({ error: message });
    }
    // Prisma "record not found"
    if (error.code === 'P2025') return reply.code(404).send({ error: 'Not found' });
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) log.error({ err: error }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'Internal server error' : error.message });
  });
}

function registerLiveSocket(app: FastifyInstance): void {
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    // Cookies ride along on cross-site WebSocket handshakes, so check the origin ourselves.
    const origin = req.headers.origin;
    if (config.isProduction && origin && new URL(origin).host !== req.headers.host) {
      socket.close(1008, 'Cross-origin connection refused');
      return;
    }
    const send = (event: LiveEvent | { type: 'hello'; data: unknown }) => {
      if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_WS_BACKLOG_BYTES) return;
      socket.send(JSON.stringify(event));
    };
    send({
      type: 'hello',
      data: { sessions: sessions.all().map(session => session.snapshot()), logs: recentLogs(), settings: getSettings() }
    });
    const unsubscribe = bus.subscribe(send);
    const heartbeat = setInterval(() => socket.readyState === socket.OPEN && socket.ping(), 30_000);
    const cleanup = () => {
      unsubscribe();
      clearInterval(heartbeat);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

async function registerDashboard(app: FastifyInstance): Promise<void> {
  if (!existsSync(path.join(config.paths.web, 'index.html'))) {
    log.warn('dashboard build not found (run "npm run build"); serving the API only');
    return;
  }
  await app.register(fastifyStatic, { root: config.paths.web, wildcard: false });
  // Client-side routes fall through to the SPA shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify's own chatter (listen addresses, per-request lines) would drown the dashboard log view.
    loggerInstance: log.child({}, { level: 'warn' }) as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024
  });
  registerErrorHandling(app);
  app.get('/api/health', async () => ({ ok: true }));

  // Headless: the terminal is the UI. Keep only the health probe for Docker / uptime checks.
  if (config.headless) return app;

  await app.register(fastifyCookie);
  // A ceiling on API traffic per client; the password endpoints set a much lower one of their own.
  await app.register(fastifyRateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: req => !req.url.startsWith('/api/')
  });
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || PUBLIC_API.has(url) || url.startsWith('/api/auth/')) return;
    if (!(await verifyToken(req.cookies[SESSION_COOKIE]))) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    // Once reached over HTTPS, browsers should refuse to fall back to plain HTTP.
    if (req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=15552000');
    reply.header('Content-Security-Policy', CSP);
  });

  registerAuthRoutes(app);
  registerBotRoutes(app);
  registerJobRoutes(app);
  registerSystemRoutes(app);
  registerLiveSocket(app);
  await registerDashboard(app);
  return app;
}
