import { Database, KeyRound, Power } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Card, CommitInput, Field, Input, Notice, PageHeader, SaveIndicator, Select, Spinner, Toggle, formatDuration, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useLive } from '../lib/live';
import type { AuthStatus, SystemInfo } from '../lib/types';

const PROVIDERS = {
  sqlite: { label: 'SQLite (built in)', placeholder: '' },
  postgresql: { label: 'PostgreSQL', placeholder: 'postgresql://user:password@host:5432/bbot' },
  mysql: { label: 'MySQL / MariaDB', placeholder: 'mysql://user:password@host:3306/bbot' },
  mongodb: { label: 'MongoDB', placeholder: 'mongodb+srv://user:password@cluster.example.net/bbot' }
} as const;
type Provider = keyof typeof PROVIDERS;

/** Poll until the server answers again after a restart. */
async function waitForServer(): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, 2000));
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch('/api/health', { cache: 'no-store' })).ok) return true;
    } catch {
      // still down
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return false;
}

function DatabaseCard({ system, reload }: { system: SystemInfo; reload: () => void }) {
  const toast = useToast();
  const current = (system.database.provider in PROVIDERS ? system.database.provider : 'sqlite') as Provider;
  const [provider, setProvider] = useState<Provider>(current);
  const [url, setUrl] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'restarting' | 'manual'>('idle');
  const locked = system.database.source === 'env';

  const apply = async (event: FormEvent) => {
    event.preventDefault();
    setState('saving');
    try {
      const { restarting } = await api<{ restarting: boolean }>('/system/database', { body: { url: provider === 'sqlite' ? null : url.trim() } });
      if (!restarting) {
        setState('manual');
        return;
      }
      setState('restarting');
      const back = await waitForServer();
      toast(back ? 'B-Bot restarted.' : 'The server did not come back. Check its logs.', back ? 'good' : 'danger');
      setUrl('');
      setState('idle');
      reload();
    } catch (error) {
      toast(errorMessage(error), 'danger');
      setState('idle');
    }
  };

  const changed = provider !== current || (provider !== 'sqlite' && url.trim() !== '');

  return (
    <Card title="Database" description="Where settings, schedules and cached messages are stored.">
      <dl className="mb-5 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">In use</dt>
          <dd className="font-medium">{PROVIDERS[current].label}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted">Location</dt>
          <dd className="truncate font-mono text-xs" title={system.database.url}>
            {system.database.url}
          </dd>
        </div>
      </dl>

      {system.database.error && (
        <div className="mb-5">
          <Notice tone="danger">
            <p className="font-medium">
              B-Bot could not use {system.database.rejectedUrl ?? 'the database you chose'} and fell back to the built-in SQLite file.
            </p>
            <pre className="mt-2 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap">{system.database.error}</pre>
          </Notice>
        </div>
      )}

      {locked ? (
        <Notice>
          The database is set by the <code className="font-mono">DATABASE_URL</code> environment variable. Change it there (for Docker, in{' '}
          <code className="font-mono">.env</code> or <code className="font-mono">docker-compose.yml</code>) and restart.
        </Notice>
      ) : (
        <form onSubmit={apply} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <Field label="Switch to">
              <Select value={provider} onChange={event => setProvider(event.target.value as Provider)}>
                {(Object.keys(PROVIDERS) as Provider[]).map(key => (
                  <option key={key} value={key}>
                    {PROVIDERS[key].label}
                  </option>
                ))}
              </Select>
            </Field>
            {provider !== 'sqlite' && (
              <Field label="Connection URL" hint={provider === 'mongodb' ? 'MongoDB must run as a replica set (Atlas clusters already do).' : undefined}>
                <Input
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={PROVIDERS[provider].placeholder}
                  value={url}
                  onChange={event => setUrl(event.target.value)}
                  required
                />
              </Field>
            )}
          </div>
          <Notice tone="warn">
            Switching starts with empty tables in the new database: settings, schedules and group rules are not copied over. Your dashboard
            password comes along, and your WhatsApp link is kept when credentials are stored on disk (the default). B-Bot restarts to apply the
            change.
          </Notice>
          {state === 'manual' && (
            <Notice>Saved. Restart B-Bot to apply it (automatic restart is only available under "npm start" or Docker).</Notice>
          )}
          <Button type="submit" variant="primary" busy={state === 'saving' || state === 'restarting'} disabled={!changed} icon={<Database className="h-4 w-4" />}>
            {state === 'restarting' ? 'Restarting…' : 'Apply and restart'}
          </Button>
        </form>
      )}
    </Card>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [auth, setAuth] = useState<AuthStatus>();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<AuthStatus>('/auth/status').then(setAuth).catch(() => {});
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/auth/password', { body: { current, next } });
      setCurrent('');
      setNext('');
      toast('Password changed. Other signed-in browsers were signed out.');
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Dashboard password">
      {auth?.managedByEnv ? (
        <Notice>
          The password is set by the <code className="font-mono">DASHBOARD_PASSWORD</code> environment variable and can only be changed there.
        </Notice>
      ) : (
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} required />
          </Field>
          <Field label="New password">
            <Input
              type="password"
              autoComplete="new-password"
              minLength={auth?.minPasswordLength ?? 8}
              value={next}
              onChange={event => setNext(event.target.value)}
              required
            />
          </Field>
          <Button type="submit" busy={busy} icon={<KeyRound className="h-4 w-4" />}>
            Change password
          </Button>
        </form>
      )}
    </Card>
  );
}

function BehaviourCard() {
  const { settings, saveSettings } = useLive();
  if (!settings) return null;
  const { general, broadcast } = settings;
  const seconds = (value: string, min: number, max: number) => Math.round(Math.min(max, Math.max(min, Number(value) || min)) * 1000);
  return (
    <Card title="Behaviour" description="How the linked account appears to others and how fast the bot sends.">
      <Toggle
        label="Appear online while the bot is connected"
        description="When off, the account shows as away even while the bot is running, and your phone keeps getting notifications as usual. People still see &quot;typing…&quot; for the moment the bot writes an answer."
        checked={general.markOnline}
        onChange={markOnline => saveSettings('general', { markOnline })}
      />
      <Toggle
        label="Mark incoming messages as read"
        description="Senders see blue ticks right away, in every chat."
        checked={general.autoRead}
        onChange={autoRead => saveSettings('general', { autoRead })}
      />
      <div className="mt-2 grid gap-4 border-t border-line pt-4 md:grid-cols-2">
        <Field label="Shortest pause between broadcast recipients (seconds)">
          <CommitInput type="number" min={0.5} max={60} step={0.5} value={broadcast.minDelayMs / 1000} onCommit={value => saveSettings('broadcast', { minDelayMs: seconds(value, 0.5, 60) })} />
        </Field>
        <Field label="Longest pause (seconds)" hint="A random pause in this range keeps bulk sends from looking like spam.">
          <CommitInput type="number" min={0.5} max={120} step={0.5} value={broadcast.maxDelayMs / 1000} onCommit={value => saveSettings('broadcast', { maxDelayMs: seconds(value, 0.5, 120) })} />
        </Field>
      </div>
    </Card>
  );
}

function BrandingCard() {
  const { settings, saveSettings } = useLive();
  if (!settings) return null;
  const { branding, commands } = settings;
  return (
    <Card title="Branding" description="The bot's name and cover image.">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
        <div className="grid content-start gap-4">
          <Field label="Bot name" hint="Shown at the top of menus and info cards.">
            <CommitInput maxLength={30} value={branding.botName} onCommit={value => void (value.trim() && saveSettings('branding', { botName: value.trim() }))} />
          </Field>
          <p className="text-sm text-muted">
            <code className="font-mono">{commands.prefix}developer</code> credits the bot's author, Buddhika Shahan. <code className="font-mono">{commands.prefix}owner</code> shares the owner numbers set on the
            Access page.
          </p>
        </div>
        <figure className="min-w-0">
          <img src="/cover.jpg" alt="The bot's default cover image" className="aspect-square w-full rounded-lg border border-line object-cover" />
          <figcaption className="mt-2 text-xs text-muted">
            Sent with {commands.prefix}menu. To use your own, put a <code className="font-mono">cover.jpg</code> in the data folder.
          </figcaption>
        </figure>
      </div>
      <div className="mt-2 border-t border-line pt-2">
        <Toggle
          label="Send the cover image with the menu"
          description={`Also used by ${commands.prefix}botinfo and ${commands.prefix}developer.`}
          checked={branding.coverOnMenu}
          onChange={coverOnMenu => saveSettings('branding', { coverOnMenu })}
        />
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const toast = useToast();
  const { saveState, saveError } = useLive();
  const [system, setSystem] = useState<SystemInfo>();
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(() => api<SystemInfo>('/system').then(setSystem).catch(() => {}), []);
  useEffect(() => {
    void load();
  }, [load]);

  const restart = async () => {
    setRestarting(true);
    try {
      await api('/system/restart', { method: 'POST', body: {} });
      const back = await waitForServer();
      toast(back ? 'B-Bot restarted.' : 'The server did not come back. Check its logs.', back ? 'good' : 'danger');
      void load();
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setRestarting(false);
    }
  };

  if (!system) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Settings" description="Behaviour, storage, dashboard access and system details." actions={<SaveIndicator state={saveState} error={saveError} />} />
      <div className="space-y-6">
        <BehaviourCard />
        <BrandingCard />
        <DatabaseCard system={system} reload={load} />
        <PasswordCard />
        <Card
          title="System"
          actions={
            system.supervised && (
              <Button size="sm" busy={restarting} onClick={restart} icon={<Power className="h-3.5 w-3.5" />}>
                Restart B-Bot
              </Button>
            )
          }
        >
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {[
              ['Version', system.version],
              ['Node.js', system.node],
              ['Platform', system.platform],
              ['Uptime', formatDuration(system.uptimeSeconds)],
              ['WhatsApp credentials', system.authStore === 'file' ? 'On disk, backed up to the database' : 'In the database'],
              ['Synced contacts', String(system.stats.contacts)]
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  );
}
