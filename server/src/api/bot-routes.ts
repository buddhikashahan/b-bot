import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listCommands, loadCommands } from '../commands/registry.js';
import { prisma } from '../db.js';
import { activityStats, recentActivity } from '../features/activity.js';
import { AiError, aiStatus, answeredBy, ask, clearMemory, getApiKey, listModels, setApiKey, verifyKey } from '../features/ai.js';
import { CustomMenuSchema, createCustomMenu, deleteCustomMenu, listCustomMenus, updateCustomMenu } from '../features/menus.js';
import { listTargets } from '../features/directory.js';
import { DownloadError, downloaderStatus, installYtDlp } from '../features/downloader.js';
import { parseWhitelist, saveGroupSetting } from '../features/group-guard.js';
import { getSettings, updateSettings, type SettingsPatch } from '../settings.js';
import { normalizeTarget } from '../scheduler/scheduler.js';
import { sessions } from '../whatsapp/session-manager.js';
import type { BotSession } from '../whatsapp/session.js';
import { asBadRequest, badRequest, notFound } from './http.js';

const StartSchema = z.object({
  method: z.enum(['qr', 'pairing']).default('qr'),
  phone: z.string().max(30).optional()
});

const GroupSettingSchema = z.object({
  antiLink: z.boolean().optional(),
  antiLinkMode: z.enum(['whatsapp', 'all']).optional(),
  antiLinkAction: z.enum(['delete', 'warn', 'kick']).optional(),
  warnLimit: z.number().int().min(1).max(20).optional(),
  whitelist: z.array(z.string().max(253)).max(100).optional(),
  welcomeEnabled: z.boolean().optional(),
  welcomeTemplate: z.string().max(2000).nullable().optional(),
  farewellEnabled: z.boolean().optional(),
  farewellTemplate: z.string().max(2000).nullable().optional()
});

const GROUP_JID = /^[\d-]{5,40}@g\.us$/;

function sessionOf(id: string): BotSession {
  const session = sessions.get(id);
  if (!session) throw notFound(`Unknown session "${id}"`);
  return session;
}

export function registerBotRoutes(app: FastifyInstance): void {
  // --- sessions ----------------------------------------------------------------------------
  app.get('/api/sessions', async () => sessions.all().map(session => session.snapshot()));

  app.post<{ Params: { id: string } }>('/api/sessions/:id/start', async req => {
    const session = sessionOf(req.params.id);
    const body = StartSchema.parse(req.body ?? {});
    await asBadRequest(() => session.start(body));
    return session.snapshot();
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', async req => {
    const session = sessionOf(req.params.id);
    await session.stop();
    return session.snapshot();
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/logout', async req => {
    const session = sessionOf(req.params.id);
    await session.logout();
    return session.snapshot();
  });

  /** Send a one-off text, used by the dashboard's "send test message". */
  app.post<{ Params: { id: string } }>('/api/sessions/:id/send', async req => {
    const session = sessionOf(req.params.id);
    const body = z.object({ to: z.string().max(60), text: z.string().min(1).max(4000) }).parse(req.body);
    const jid = body.to === 'alert' ? session.alertJid() : normalizeTarget(body.to);
    if (!jid) throw badRequest('Enter a valid phone number or chat ID.');
    await asBadRequest(() => session.send(jid, { text: body.text }));
    return { ok: true };
  });

  // --- settings ----------------------------------------------------------------------------
  app.get('/api/settings', async () => getSettings());

  app.patch('/api/settings', async req => {
    const patch = z.record(z.string(), z.record(z.string(), z.unknown())).parse(req.body);
    return updateSettings(patch as SettingsPatch);
  });

  // --- chats & groups ----------------------------------------------------------------------
  app.get<{ Querystring: { refresh?: string } }>('/api/targets', async req =>
    listTargets(sessions.require(), req.query.refresh === '1')
  );

  app.get<{ Querystring: { refresh?: string } }>('/api/groups', async req => {
    const bot = sessions.require();
    if (req.query.refresh === '1' && bot.connected) await bot.refreshGroups().catch(() => {});
    const rows = await prisma.groupSetting.findMany({ where: { sessionId: bot.id } });
    const settings = new Map(rows.map(row => [row.jid, row]));
    const defaults = getSettings().groups;
    return bot
      .listGroups()
      .map(meta => {
        const row = settings.get(meta.id);
        return {
          jid: meta.id,
          name: meta.subject || meta.id,
          size: meta.size ?? meta.participants.length,
          botIsAdmin: bot.botIsAdmin(meta),
          antiLink: row?.antiLink ?? false,
          antiLinkMode: row?.antiLinkMode ?? 'whatsapp',
          antiLinkAction: row?.antiLinkAction ?? 'delete',
          warnLimit: row?.warnLimit ?? 3,
          whitelist: parseWhitelist(row ?? null),
          welcomeEnabled: row?.welcomeEnabled ?? false,
          welcomeTemplate: row?.welcomeTemplate || defaults.defaultWelcome,
          farewellEnabled: row?.farewellEnabled ?? false,
          farewellTemplate: row?.farewellTemplate || defaults.defaultFarewell
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  app.put<{ Params: { jid: string } }>('/api/groups/:jid', async req => {
    const bot = sessions.require();
    const { jid } = req.params;
    if (!GROUP_JID.test(jid)) throw badRequest('Invalid group ID.');
    const body = GroupSettingSchema.parse(req.body);
    const name = bot.listGroups().find(meta => meta.id === jid)?.subject;
    const row = await saveGroupSetting(bot.id, jid, { ...body, ...(name ? { name } : {}) });
    return { ...row, whitelist: parseWhitelist(row) };
  });

  // --- activity ----------------------------------------------------------------------------
  app.get<{ Querystring: { limit?: string; type?: string } }>('/api/activity', async req =>
    recentActivity(sessions.require().id, Number(req.query.limit) || 50, req.query.type || undefined)
  );

  /** Numbers for the dashboard home page. */
  app.get('/api/overview', async () => {
    const bot = sessions.require();
    const [stats, cachedMessages, contacts, activeJobs, autoGroups] = await Promise.all([
      activityStats(bot.id),
      prisma.cachedMessage.count({ where: { sessionId: bot.id } }),
      prisma.contact.count({ where: { sessionId: bot.id } }),
      prisma.scheduledJob.count({ where: { sessionId: bot.id, status: { in: ['pending', 'active', 'running'] } } }),
      prisma.groupSetting.count({ where: { sessionId: bot.id, OR: [{ antiLink: true }, { welcomeEnabled: true }, { farewellEnabled: true }] } })
    ]);
    const menus = await prisma.customMenu.count({ where: { sessionId: bot.id } });
    return {
      stats,
      aiConfigured: Boolean(await getApiKey()),
      counts: { cachedMessages, contacts, activeJobs, groups: bot.listGroups().length, managedGroups: autoGroups, menus },
      uptimeSeconds: Math.round(process.uptime())
    };
  });

  // --- AI assistant ------------------------------------------------------------------------
  app.get('/api/ai', async () => aiStatus());

  /** Save a Gemini API key, but only after Google has accepted it. The key is never sent back. */
  app.put('/api/ai/key', async req => {
    const { key } = z.object({ key: z.string().trim().min(10).max(200) }).parse(req.body);
    let models: string[];
    try {
      models = await verifyKey(key);
    } catch (error) {
      throw badRequest(error instanceof AiError ? error.message : 'Could not check the key with Google.');
    }
    await setApiKey(key);
    // Tell the dashboard when the chosen model is not one this key can use.
    return { ...(await aiStatus()), models, modelAvailable: models.length === 0 || models.includes(getSettings().ai.model) };
  });

  app.delete('/api/ai/key', async () => {
    await setApiKey(null);
    await updateSettings({ ai: { enabled: false } });
    return aiStatus();
  });

  app.get('/api/ai/models', async () => {
    const key = await getApiKey();
    if (!key) return [];
    return listModels(key).catch(() => [] as string[]);
  });

  /** "Try it" box: ask the assistant something with the current instructions. Nothing is remembered. */
  app.post('/api/ai/test', async req => {
    const { message } = z.object({ message: z.string().trim().min(1).max(2000) }).parse(req.body);
    try {
      const started = Date.now();
      const reply = await ask(sessions.require(), { chatJid: 'dashboard', text: message, senderName: 'the owner (testing from the dashboard)', stateless: true });
      return { reply, model: answeredBy(), seconds: Math.round((Date.now() - started) / 100) / 10 };
    } catch (error) {
      throw badRequest(error instanceof AiError ? error.message : 'The AI could not answer.');
    }
  });

  app.delete('/api/ai/memory', async () => ({ removed: await clearMemory(sessions.require().id) }));

  // --- reply-by-number menus ---------------------------------------------------------------
  app.get('/api/menus', async () => listCustomMenus(sessions.require().id));

  app.post('/api/menus', async req => createCustomMenu(sessions.require().id, CustomMenuSchema.parse(req.body)));

  app.put<{ Params: { id: string } }>('/api/menus/:id', async req => updateCustomMenu(req.params.id, CustomMenuSchema.parse(req.body)));

  app.delete<{ Params: { id: string } }>('/api/menus/:id', async req => {
    await deleteCustomMenu(req.params.id);
    return { ok: true };
  });

  // --- media downloader --------------------------------------------------------------------
  app.get('/api/downloads', async () => downloaderStatus());

  /** Install yt-dlp, or replace it with the latest release (sites change often). */
  app.post('/api/downloads/update', async () => {
    try {
      await installYtDlp();
    } catch (error) {
      throw badRequest(error instanceof DownloadError ? error.message : 'Could not download yt-dlp. Check the internet connection.');
    }
    return downloaderStatus();
  });

  // --- commands ----------------------------------------------------------------------------
  app.get('/api/commands', async () => {
    const disabled = new Set(getSettings().commands.disabled);
    return listCommands().map(command => ({ ...command, enabled: !disabled.has(command.name) }));
  });

  app.post('/api/commands/reload', async () => {
    await loadCommands();
    return { count: listCommands().length };
  });
}
