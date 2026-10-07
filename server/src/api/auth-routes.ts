import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  isSetupRequired,
  issueToken,
  passwordManagedByEnv,
  setPassword,
  verifyPassword,
  verifyToken
} from '../auth/dashboard-auth.js';
import { scoped } from '../logger.js';
import { HttpError, badRequest, conflict } from './http.js';

const log = scoped('auth');
const Password = z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`).max(200);
// Brute-force guard for every endpoint that accepts a password.
const limited = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

async function startSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.setCookie(SESSION_COOKIE, await issueToken(), {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: req.protocol === 'https',
    maxAge: SESSION_TTL_MS / 1000
  });
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/api/auth/status', async req => ({
    authenticated: await verifyToken(req.cookies[SESSION_COOKIE]),
    setupRequired: await isSetupRequired(),
    managedByEnv: passwordManagedByEnv(),
    minPasswordLength: MIN_PASSWORD_LENGTH
  }));

  /** First run only: whoever opens the dashboard first chooses the admin password. */
  app.post('/api/auth/setup', limited, async (req, reply) => {
    if (!(await isSetupRequired())) throw conflict('A password is already configured.');
    const { password } = z.object({ password: Password }).parse(req.body);
    await setPassword(password);
    await startSession(req, reply);
    log.info('dashboard password created');
    return { ok: true };
  });

  app.post('/api/auth/login', limited, async (req, reply) => {
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
    if (!(await verifyPassword(password))) {
      log.warn(`failed dashboard login from ${req.ip}`);
      throw new HttpError(401, 'Wrong password.');
    }
    await startSession(req, reply);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', limited, async (req, reply) => {
    if (!(await verifyToken(req.cookies[SESSION_COOKIE]))) throw new HttpError(401, 'Not authenticated');
    if (passwordManagedByEnv()) throw conflict('The password is set by DASHBOARD_PASSWORD and cannot be changed here.');
    const body = z.object({ current: z.string().max(200), next: Password }).parse(req.body);
    if (!(await verifyPassword(body.current))) throw badRequest('Current password is wrong.');
    await setPassword(body.next);
    // Changing the password invalidates every session, including this one, so issue a new cookie.
    await startSession(req, reply);
    log.info('dashboard password changed');
    return { ok: true };
  });
}
