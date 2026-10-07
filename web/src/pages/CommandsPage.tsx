import { Download, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CommitInput, Field, Input, PageHeader, Spinner, Toggle, cx, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useLive } from '../lib/live';
import type { CommandInfo, DownloaderStatus, Settings } from '../lib/types';

const CATEGORIES: [CommandInfo['category'], string][] = [
  ['general', 'General'],
  ['ai', 'AI assistant'],
  ['download', 'Downloads'],
  ['info', 'Search & info'],
  ['media', 'Media'],
  ['utility', 'Tools'],
  ['admin', 'Group admin'],
  ['fun', 'Fun']
];

/** Clamp a typed number into the range the server accepts. */
function bounded(value: string, min: number, max: number): number {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

function DownloadsCard() {
  const { settings, saveSettings } = useLive();
  const toast = useToast();
  const [status, setStatus] = useState<DownloaderStatus>();
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    api<DownloaderStatus>('/downloads').then(setStatus).catch(() => {});
  }, []);

  if (!settings) return null;
  const { downloads } = settings;

  const update = async () => {
    setUpdating(true);
    try {
      const next = await api<DownloaderStatus>('/downloads/update', { method: 'POST', body: {} });
      setStatus(next);
      toast(`Downloader ready (yt-dlp ${next.ytDlpVersion ?? ''}).`);
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <Card
      title="Media downloads"
      description="Songs and videos from YouTube, Facebook, TikTok, Instagram, X and Pinterest. Files are fetched by this server, sent, then deleted."
      actions={
        <Button size="sm" busy={updating} onClick={update} icon={<Download className="h-3.5 w-3.5" />}>
          {status?.ytDlpVersion ? 'Update downloader' : 'Install downloader'}
        </Button>
      }
    >
      <Toggle label="Allow download commands" checked={downloads.enabled} onChange={enabled => saveSettings('downloads', { enabled })} />
      <Toggle
        label="Owners only"
        description="Downloads use this machine's bandwidth and disk. Turn on to keep them to yourself."
        checked={downloads.ownerOnly}
        onChange={ownerOnly => saveSettings('downloads', { ownerOnly })}
        disabled={!downloads.enabled}
      />
      <div className="mt-2 grid gap-4 border-t border-line pt-4 md:grid-cols-2">
        <Field label="Largest file (MB)" hint="5 to 500. Bigger files are refused.">
          <CommitInput type="number" min={5} max={500} value={downloads.maxSizeMb} onCommit={value => saveSettings('downloads', { maxSizeMb: bounded(value, 5, 500) })} />
        </Field>
        <Field label="Longest video or song (minutes)" hint="1 to 240. Live streams are always refused.">
          <CommitInput type="number" min={1} max={240} value={downloads.maxMinutes} onCommit={value => saveSettings('downloads', { maxMinutes: bounded(value, 1, 240) })} />
        </Field>
      </div>
      {status && (
        <ul className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
          <li className="flex flex-wrap items-center gap-2">
            <Badge tone={status.ytDlpVersion ? 'good' : 'warn'}>{status.ytDlpVersion ? `yt-dlp ${status.ytDlpVersion}` : 'yt-dlp not installed'}</Badge>
            <span className="text-muted">
              {status.ytDlpVersion
                ? 'If a site stops working, update the downloader: sites change often.'
                : status.supported
                  ? 'It is downloaded automatically the first time someone uses a download command.'
                  : 'No ready-made build exists for this machine. Install yt-dlp yourself and set YTDLP_PATH.'}
            </span>
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <Badge tone={status.ffmpeg ? 'good' : 'warn'}>{status.ffmpeg ? 'ffmpeg found' : 'ffmpeg not found'}</Badge>
            <span className="text-muted">
              {status.ffmpeg ? 'Videos are sent in up to 720p.' : 'Needed for YouTube videos. Run npm install again, or install ffmpeg on this machine.'}
            </span>
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <Badge tone={status.cookies ? 'good' : 'neutral'}>{status.cookies ? 'cookies.txt found' : 'no cookies.txt'}</Badge>
            <span className="text-muted">Optional. Some Instagram and age-restricted posts only download with a login; see the README.</span>
          </li>
        </ul>
      )}
    </Card>
  );
}

const PLUGIN_EXAMPLE = `// data/plugins/hello.js
export default {
  name: 'hello',
  aliases: ['hi'],
  category: 'fun',
  description: 'Say hello back.',
  cooldown: 5,
  async execute(ctx) {
    await ctx.reply(\`Hello \${ctx.senderName || 'there'}! 👋\`);
  }
};`;

export function CommandsPage() {
  const { settings, setSettings, saveSettings } = useLive();
  const toast = useToast();
  const [commands, setCommands] = useState<CommandInfo[]>();
  const [reloading, setReloading] = useState(false);
  const [pending, setPending] = useState<string>();
  const [query, setQuery] = useState('');

  const load = useCallback(() => api<CommandInfo[]>('/commands').then(setCommands).catch(() => setCommands([])), []);
  useEffect(() => {
    void load();
  }, [load, settings?.commands.disabled]);

  const toggle = async (command: CommandInfo) => {
    if (!settings) return;
    setPending(command.name);
    const disabled = command.enabled
      ? [...settings.commands.disabled, command.name]
      : settings.commands.disabled.filter(name => name !== command.name);
    try {
      setSettings(await api<Settings>('/settings', { method: 'PATCH', body: { commands: { disabled } } }));
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setPending(undefined);
    }
  };

  const reload = async () => {
    setReloading(true);
    try {
      const { count } = await api<{ count: number }>('/commands/reload', { method: 'POST', body: {} });
      await load();
      toast(`Reloaded. ${count} commands available.`);
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setReloading(false);
    }
  };

  const prefix = settings?.commands.prefix ?? '.';
  const needle = query.trim().toLowerCase().replace(prefix, '');
  const matches = (command: CommandInfo) =>
    !needle ||
    command.name.includes(needle) ||
    command.description.toLowerCase().includes(needle) ||
    Boolean(command.aliases?.some(alias => alias.includes(needle)));
  const total = commands?.length ?? 0;
  const enabledCount = commands?.filter(command => command.enabled).length ?? 0;

  return (
    <>
      <PageHeader
        title="Commands"
        description={`Messages starting with "${prefix}" are treated as commands. ${enabledCount} of ${total} are switched on.`}
        actions={
          <Button onClick={reload} busy={reloading} icon={<RefreshCw className="h-4 w-4" />}>
            Reload plugins
          </Button>
        }
      />

      <div className="space-y-6">
        {settings && (
          <Card>
            <div className="grid gap-x-8 gap-y-2 md:grid-cols-[1fr_200px]">
              <Toggle
                label="Respond to commands"
                description="Turn off to make the bot ignore every command. Who may use them is set under Access."
                checked={settings.commands.enabled}
                onChange={enabled => saveSettings('commands', { enabled })}
              />
              <Field label="Prefix" hint="1 to 3 characters.">
                <CommitInput maxLength={3} value={settings.commands.prefix} onCommit={value => value.trim() && saveSettings('commands', { prefix: value.trim() })} />
              </Field>
            </div>
          </Card>
        )}

        <DownloadsCard />

        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-3 left-3 h-4 w-4 text-muted" aria-hidden />
          <Input aria-label="Search commands" placeholder="Search commands" className="pl-9" value={query} onChange={event => setQuery(event.target.value)} />
        </div>

        {!commands ? (
          <div className="flex items-center gap-3 text-muted">
            <Spinner /> Loading…
          </div>
        ) : (
          CATEGORIES.map(([category, title]) => {
            const items = commands.filter(command => command.category === category && matches(command));
            if (items.length === 0) return null;
            return (
              <Card key={category} title={title}>
                <ul className="-my-2 divide-y divide-line">
                  {items.map(command => (
                    <li key={command.name} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className={cx('font-mono text-sm font-medium', !command.enabled && 'text-muted line-through')}>
                            {prefix}
                            {command.usage ?? command.name}
                          </code>
                          {command.ownerOnly && <Badge>owner</Badge>}
                          {command.adminOnly && <Badge>group admin</Badge>}
                          {command.source === 'plugin' && <Badge tone="good">plugin</Badge>}
                        </div>
                        <p className="mt-0.5 text-sm text-muted">
                          {command.description}
                          {command.aliases?.length ? ` Also: ${command.aliases.map(alias => prefix + alias).join(', ')}.` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={command.enabled}
                        aria-label={`${command.enabled ? 'Disable' : 'Enable'} ${command.name}`}
                        disabled={pending === command.name}
                        onClick={() => toggle(command)}
                        className={cx(
                          'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
                          command.enabled ? 'bg-accent' : 'bg-line'
                        )}
                      >
                        <span className={cx('absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', command.enabled && 'translate-x-5')} />
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })
        )}

        {commands && needle && !commands.some(matches) && <p className="text-sm text-muted">No command matches "{query}".</p>}

        <Card title="Write your own" description="Drop an ES module into the data/plugins folder, then press Reload plugins. Plugins run with full access to the bot, so only install code you trust.">
          <pre className="overflow-x-auto rounded-lg bg-raised p-4 font-mono text-xs leading-relaxed">{PLUGIN_EXAMPLE}</pre>
        </Card>
      </div>
    </>
  );
}
