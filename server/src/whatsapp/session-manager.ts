import { config, DEFAULT_SESSION_ID } from '../config.js';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';
import { BotSession } from './session.js';

const log = scoped('sessions');

/**
 * Owns every BotSession. Only the "default" session is created today, but
 * nothing below assumes a single one: routes, tables and features are all
 * keyed by session id, so multi-account support is a matter of calling
 * `create()` with more ids.
 */
class SessionManager {
  private readonly sessions = new Map<string, BotSession>();

  async create(id: string): Promise<BotSession> {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const session = new BotSession(id);
    await session.init();
    this.sessions.set(id, session);
    return session;
  }

  get(id: string = DEFAULT_SESSION_ID): BotSession | undefined {
    return this.sessions.get(id);
  }

  require(id: string = DEFAULT_SESSION_ID): BotSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session "${id}"`);
    return session;
  }

  all(): BotSession[] {
    return [...this.sessions.values()];
  }

  /** Create the default session and resume it when a device is already linked. */
  async boot(): Promise<void> {
    const session = await this.create(DEFAULT_SESSION_ID);
    const row = await prisma.session.findUnique({ where: { id: session.id } });

    if (session.paired && row?.autoStart !== false) {
      log.info('linked device found, connecting');
      await session.start();
    } else if (config.headless && !session.paired) {
      log.info('headless mode: starting pairing in the terminal');
      await session.start(config.pairingPhone ? { method: 'pairing', phone: config.pairingPhone } : { method: 'qr' });
    } else if (session.paired) {
      log.info('linked device found but it was stopped manually; not connecting');
    } else {
      log.info('no linked device yet; open the dashboard to pair one');
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.all().map(session => session.shutdown()));
  }
}

export const sessions = new SessionManager();
