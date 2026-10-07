import type { Boom } from '@hapi/boom';
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type AnyMessageContent,
  type ConnectionState,
  type GroupMetadata,
  type MiscMessageGenerationOptions,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type proto
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import { bus } from '../bus.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { scoped } from '../logger.js';
import { getSettings } from '../settings.js';
import { createAuthStore, isPaired, type AuthStore } from './auth-state.js';
import { attachHandlers, lookupMessage } from './handlers.js';
import { participantIds, phoneToJid, userPart } from './message-utils.js';

export type SessionStatus =
  | 'disconnected'
  | 'connecting'
  | 'awaiting_qr'
  | 'awaiting_pairing'
  | 'connected'
  | 'reconnecting';

export type PairMethod = 'qr' | 'pairing';

export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  detail?: string;
  paired: boolean;
  method: PairMethod;
  authStore: 'file' | 'database';
  me?: { jid: string; phone: string; name?: string };
  qr?: { dataUrl: string; expiresAt: number; seq: number };
  pairing?: { code: string; phone: string; expiresAt: number };
  retry?: { attempt: number; nextAt: number };
  lastDisconnect?: { code?: number; reason: string; at: number };
  connectedAt?: number;
}

// Baileys keeps the first QR for 60s and each later one for 20s before the server runs out of refs.
const FIRST_QR_TTL_MS = 60_000;
const NEXT_QR_TTL_MS = 20_000;
/** Rough lifetime of the unpaired socket, which is how long a pairing code stays usable. */
const PAIRING_WINDOW_MS = 160_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** A connection must survive this long before the backoff counter resets. */
const STABLE_AFTER_MS = 60_000;
const GROUP_CACHE_TTL_MS = 5 * 60_000;
const SENT_CACHE_SIZE = 500;

export class BotSession {
  readonly log: Logger;
  sock?: WASocket;

  private store?: AuthStore;
  private status: SessionStatus = 'disconnected';
  private detail?: string;
  private method: PairMethod = 'qr';
  private pairingPhone?: string;
  private pairingRequested = false;
  private qr?: SessionSnapshot['qr'];
  private qrSeq = 0;
  private pairing?: SessionSnapshot['pairing'];
  /** Bumped whenever the active socket changes, so events from an old socket are ignored. */
  private generation = 0;
  private retryAttempt = 0;
  private retryTimer?: NodeJS.Timeout;
  private retryAt?: number;
  private stableTimer?: NodeJS.Timeout;
  private lastDisconnect?: SessionSnapshot['lastDisconnect'];
  private connectedAt?: number;
  private readonly groupCache = new Map<string, { meta: GroupMetadata; at: number }>();
  private readonly sent = new Map<string, proto.IMessage>();

  constructor(readonly id: string) {
    this.log = scoped(id === 'default' ? 'whatsapp' : `whatsapp:${id}`);
  }

  // --- lifecycle ---------------------------------------------------------------------------

  async init(): Promise<void> {
    await prisma.session.upsert({ where: { id: this.id }, create: { id: this.id, name: this.id }, update: {} });
    this.store = await createAuthStore(this.id);
  }

  get paired(): boolean {
    return this.store ? isPaired(this.store.state.creds) : false;
  }

  get connected(): boolean {
    return this.status === 'connected' && Boolean(this.sock);
  }

  get me(): { jid: string; lid?: string; name?: string } | undefined {
    if (!this.paired) return undefined;
    const user = this.sock?.user ?? this.store?.state.creds.me;
    if (!user?.id) return undefined;
    return {
      jid: jidNormalizedUser(user.id),
      lid: user.lid ? jidNormalizedUser(user.lid) : undefined,
      name: user.name
    };
  }

  /** Start (or restart) the connection. Pairing options only matter while the device is unlinked. */
  async start(options: { method?: PairMethod; phone?: string } = {}): Promise<void> {
    const method = options.method ?? 'qr';
    const phone = options.phone?.replace(/\D/g, '');
    if (!this.paired && method === 'pairing' && !/^\d{7,15}$/.test(phone ?? '')) {
      throw new Error('Enter the full phone number with country code, digits only (e.g. 15551234567).');
    }
    await this.teardown();
    if (!this.paired) {
      // A half-finished pairing leaves partial creds behind; always pair from a clean slate.
      await this.resetAuth();
      this.method = method;
      this.pairingPhone = phone;
    }
    this.retryAttempt = 0;
    this.detail = undefined;
    await this.connect();
  }

  /** Close the socket but keep the device linked. */
  async stop(): Promise<void> {
    await this.teardown();
    await prisma.session.update({ where: { id: this.id }, data: { autoStart: false } });
    this.clearPairingState();
    this.setStatus('disconnected', this.paired ? 'Stopped. The device is still linked; connect to resume.' : undefined);
  }

  /** Unlink the device from the WhatsApp account and erase the stored credentials. */
  async logout(): Promise<void> {
    const sock = this.sock;
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
    this.sock = undefined;
    if (sock) {
      await sock.logout().catch(err => this.log.warn({ err }, 'logout request failed; clearing local credentials anyway'));
    }
    await this.resetAuth();
    await prisma.session.update({ where: { id: this.id }, data: { autoStart: false, phone: null, pushName: null } });
    this.clearPairingState();
    this.setStatus('disconnected', 'Logged out. Pair a device to connect again.');
  }

  async shutdown(): Promise<void> {
    await this.teardown();
    await this.store?.flush().catch(err => this.log.warn({ err }, 'failed to flush auth state'));
  }

  private async teardown(): Promise<void> {
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
    this.retryAt = undefined;
    const sock = this.sock;
    this.sock = undefined;
    this.connectedAt = undefined;
    if (sock) await sock.end(undefined).catch(() => {});
  }

  private async resetAuth(): Promise<void> {
    await this.store?.clear();
    this.store = await createAuthStore(this.id);
    this.groupCache.clear();
  }

  private clearPairingState(): void {
    this.qr = undefined;
    this.qrSeq = 0;
    this.pairing = undefined;
    this.pairingRequested = false;
    this.retryAt = undefined;
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.retryTimer);
    this.clearPairingState();
    this.store ??= await createAuthStore(this.id);
    const store = this.store;
    this.setStatus(this.retryAttempt > 0 ? 'reconnecting' : 'connecting');

    const baileysLog = this.log.child({ mod: 'baileys' }, { level: 'warn' });
    let sock: WASocket;
    try {
      sock = makeWASocket({
        ...(config.waVersion ? { version: config.waVersion } : {}),
        auth: { creds: store.state.creds, keys: makeCacheableSignalKeyStore(store.state.keys, baileysLog) },
        logger: baileysLog,
        // Pairing codes are only accepted from a recognised browser identity.
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: getSettings().general.markOnline,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        getMessage: key => this.getMessage(key),
        cachedGroupMetadata: async jid => this.cachedGroup(jid)
      });
    } catch (err) {
      this.log.error({ err }, 'failed to create socket');
      this.scheduleReconnect(false);
      return;
    }
    this.sock = sock;

    const isCurrent = () => generation === this.generation;
    sock.ev.on('creds.update', () => {
      void store.saveCreds().catch(err => this.log.error({ err }, 'failed to save credentials'));
    });
    sock.ev.on('connection.update', update => {
      if (!isCurrent()) return;
      void this.onConnectionUpdate(sock, update).catch(err => this.log.error({ err }, 'connection handler failed'));
    });
    attachHandlers(this, sock, isCurrent);
  }

  private async onConnectionUpdate(sock: WASocket, update: Partial<ConnectionState>): Promise<void> {
    if (update.qr) await this.onQr(sock, update.qr);
    if (update.isNewLogin) this.log.info('device linked, restarting connection');
    if (update.connection === 'open') await this.onOpen(sock);
    if (update.connection === 'close') await this.onClose(update.lastDisconnect?.error);
  }

  private async onQr(sock: WASocket, qr: string): Promise<void> {
    if (this.method === 'pairing' && this.pairingPhone) {
      // The first QR ref doubles as the "socket is ready for pairing" signal.
      if (this.pairingRequested) return;
      this.pairingRequested = true;
      const phone = this.pairingPhone;
      try {
        const raw = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g)?.join('-') ?? raw;
        this.pairing = { code, phone, expiresAt: Date.now() + PAIRING_WINDOW_MS };
        this.setStatus('awaiting_pairing');
        // The code is a credential: keep it out of the logs unless the terminal is the only UI.
        if (config.headless) console.log(`\nPairing code for +${phone}: ${code}\n`);
        else this.log.info(`pairing code issued for +${phone}`);
      } catch (err) {
        this.log.error({ err }, 'pairing code request failed');
        await this.teardown();
        this.clearPairingState();
        this.setStatus('disconnected', 'WhatsApp rejected the pairing code request. Check the number and try again.');
      }
      return;
    }

    this.qrSeq++;
    const ttl = this.qrSeq === 1 ? FIRST_QR_TTL_MS : NEXT_QR_TTL_MS;
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
    this.qr = { dataUrl, expiresAt: Date.now() + ttl, seq: this.qrSeq };
    this.setStatus('awaiting_qr');
    if (config.headless) {
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
      console.log('Scan with WhatsApp > Linked devices > Link a device\n');
    }
  }

  private async onOpen(sock: WASocket): Promise<void> {
    this.clearPairingState();
    this.connectedAt = Date.now();
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => (this.retryAttempt = 0), STABLE_AFTER_MS);
    this.stableTimer.unref();
    this.setStatus('connected');
    const me = this.me;
    this.log.info(`connected as +${userPart(me?.jid)}`);
    await prisma.session.update({
      where: { id: this.id },
      data: {
        phone: userPart(me?.jid) || null,
        pushName: sock.user?.name ?? null,
        authMethod: this.method,
        autoStart: true,
        lastConnectedAt: new Date()
      }
    });
    void this.refreshGroups().catch(err => this.log.warn({ err }, 'initial group sync failed'));
  }

  private async onClose(error: Error | undefined): Promise<void> {
    const code = (error as Boom | undefined)?.output?.statusCode;
    const reason = error?.message || 'connection closed';
    this.sock = undefined;
    this.connectedAt = undefined;
    clearTimeout(this.stableTimer);
    this.lastDisconnect = { code, reason, at: Date.now() };
    this.clearPairingState();

    if (code === DisconnectReason.restartRequired) {
      // Normal right after pairing: WhatsApp asks the new device to reconnect.
      this.log.info('restart required, reconnecting');
      await this.connect();
      return;
    }

    this.log.warn(`connection closed (${code ?? 'no code'}): ${reason}`);

    if (code === DisconnectReason.loggedOut) {
      await this.resetAuth();
      await prisma.session.update({ where: { id: this.id }, data: { autoStart: false } });
      return this.halt('This device was logged out from WhatsApp. Pair again to reconnect.');
    }
    if (code === DisconnectReason.connectionReplaced) {
      return this.halt('Another client opened this session and replaced the connection. Connect again to take it back.');
    }
    if (code === DisconnectReason.forbidden) {
      return this.halt('WhatsApp refused the connection (403). The account may be restricted or banned.');
    }
    if (code === DisconnectReason.multideviceMismatch) {
      return this.halt('Multi-device mismatch. Log out and pair the device again.');
    }
    if (!this.paired) {
      // Nothing to resume: the QR / pairing window lapsed or the attempt failed.
      // Drop the half-written pairing creds so a retry registers instead of logging in.
      await this.resetAuth();
      if (config.headless) return this.scheduleReconnect(false);
      return this.halt(
        code === DisconnectReason.timedOut
          ? 'Pairing timed out before a device was linked. Start again for a fresh code.'
          : `Pairing failed: ${reason}`
      );
    }
    // connectionLost / connectionClosed / timedOut / unavailableService / badSession and anything unknown.
    this.scheduleReconnect(code === 429);
  }

  private halt(detail: string): void {
    this.generation++;
    this.setStatus('disconnected', detail);
  }

  private scheduleReconnect(rateLimited: boolean): void {
    this.retryAttempt++;
    const base = rateLimited ? 60_000 : 2_000;
    const exponential = Math.min(base * 2 ** Math.min(this.retryAttempt - 1, 10), MAX_BACKOFF_MS);
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    const generation = ++this.generation;
    this.retryAt = Date.now() + delay;
    this.setStatus('reconnecting', rateLimited ? 'Rate limited by WhatsApp, backing off.' : undefined);
    this.log.info(`reconnect attempt ${this.retryAttempt} in ${Math.round(delay / 1000)}s`);
    this.retryTimer = setTimeout(() => {
      if (generation === this.generation) void this.connect();
    }, delay);
  }

  // --- state -------------------------------------------------------------------------------

  private setStatus(status: SessionStatus, detail?: string): void {
    this.status = status;
    this.detail = detail;
    bus.publish({ type: 'session', data: this.snapshot() });
  }

  snapshot(): SessionSnapshot {
    const me = this.me;
    return {
      id: this.id,
      status: this.status,
      detail: this.detail,
      paired: this.paired,
      method: this.method,
      authStore: config.authStore,
      me: me ? { jid: me.jid, phone: userPart(me.jid), name: me.name } : undefined,
      qr: this.qr,
      pairing: this.pairing,
      retry: this.status === 'reconnecting' && this.retryAt ? { attempt: this.retryAttempt, nextAt: this.retryAt } : undefined,
      lastDisconnect: this.lastDisconnect,
      connectedAt: this.connectedAt
    };
  }

  // --- messaging ---------------------------------------------------------------------------

  requireSock(): WASocket {
    if (!this.sock || this.status !== 'connected') throw new Error('WhatsApp is not connected');
    return this.sock;
  }

  async send(
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions
  ): Promise<WAMessage | undefined> {
    const message = await this.requireSock().sendMessage(jid, content, options);
    if (message?.key.id && message.message) {
      this.sent.set(message.key.id, message.message);
      if (this.sent.size > SENT_CACHE_SIZE) this.sent.delete(this.sent.keys().next().value!);
    }
    return message;
  }

  /** Download and decrypt the media attached to a message. */
  download(msg: WAMessage): Promise<Buffer> {
    const sock = this.requireSock();
    return downloadMediaMessage(msg, 'buffer', {}, { logger: this.log, reuploadRequest: sock.updateMediaMessage });
  }

  /** True for messages this process sent itself (as opposed to the owner typing on their phone). */
  sentByBot(messageId: string | null | undefined): boolean {
    return Boolean(messageId && this.sent.has(messageId));
  }

  /** Lets Baileys re-encrypt a message when a recipient asks for a retry. */
  private async getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    if (!key.id) return undefined;
    return this.sent.get(key.id) ?? (await lookupMessage(this.id, key.id));
  }

  /** Where alerts (deleted messages, revealed view-once media, statuses) are delivered. */
  alertJid(): string | undefined {
    const target = getSettings().general.alertTarget;
    return target === 'owner' ? this.me?.jid : target;
  }

  async pnForLid(lid: string): Promise<string | undefined> {
    try {
      const pn = await this.sock?.signalRepository.lidMapping.getPNForLID(lid);
      return pn ? jidNormalizedUser(pn) : undefined;
    } catch {
      return undefined;
    }
  }

  /** True when the JID (phone-number or LID form) is the linked account itself. */
  async isSelf(jid: string): Promise<boolean> {
    const me = this.me;
    if (!me) return false;
    const id = jidNormalizedUser(jid);
    if (id === me.jid || id === me.lid) return true;
    return isLidUser(id) ? (await this.pnForLid(id)) === me.jid : false;
  }

  async isOwner(ids: string[]): Promise<boolean> {
    const me = this.me;
    const owners = new Set<string>(getSettings().general.ownerNumbers.map(phoneToJid));
    if (me) owners.add(me.jid);
    if (me?.lid) owners.add(me.lid);
    for (const id of ids) {
      if (owners.has(id)) return true;
      if (isLidUser(id)) {
        const pn = await this.pnForLid(id);
        if (pn && owners.has(pn)) return true;
      }
    }
    return false;
  }

  // --- groups ------------------------------------------------------------------------------

  private cachedGroup(jid: string): GroupMetadata | undefined {
    const entry = this.groupCache.get(jid);
    return entry && Date.now() - entry.at < GROUP_CACHE_TTL_MS ? entry.meta : undefined;
  }

  async groupMeta(jid: string, fresh = false): Promise<GroupMetadata | undefined> {
    if (!fresh) {
      const cached = this.cachedGroup(jid);
      if (cached) return cached;
    }
    try {
      const meta = await this.requireSock().groupMetadata(jid);
      this.groupCache.set(jid, { meta, at: Date.now() });
      return meta;
    } catch (err) {
      this.log.debug({ err }, `could not load metadata for ${jid}`);
      return this.groupCache.get(jid)?.meta;
    }
  }

  async refreshGroups(): Promise<GroupMetadata[]> {
    const groups = await this.requireSock().groupFetchAllParticipating();
    const now = Date.now();
    this.groupCache.clear();
    for (const meta of Object.values(groups)) this.groupCache.set(meta.id, { meta, at: now });
    bus.publish({ type: 'directory', data: { reason: 'groups' } });
    return Object.values(groups);
  }

  listGroups(): GroupMetadata[] {
    return [...this.groupCache.values()].map(entry => entry.meta);
  }

  invalidateGroup(jid: string): void {
    const entry = this.groupCache.get(jid);
    if (entry) entry.at = 0;
  }

  isGroupAdmin(meta: GroupMetadata, ids: string[]): boolean {
    const wanted = new Set(ids);
    return meta.participants.some(p => Boolean(p.admin) && participantIds(p).some(id => wanted.has(id)));
  }

  botIsAdmin(meta: GroupMetadata): boolean {
    const me = this.me;
    if (!me) return false;
    return this.isGroupAdmin(meta, [me.jid, ...(me.lid ? [me.lid] : [])]);
  }
}
