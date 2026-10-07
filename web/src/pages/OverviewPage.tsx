import { ArrowRight, Check, Eye, Lock, Megaphone, MessageSquareReply, Moon, PhoneOff, Plug, Sparkles, Trash2, X, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ACTIVITY, ActivityList } from '../components/shared';
import { Badge, Button, Card, Notice, PageHeader, SaveIndicator, Spinner, cx, formatDuration } from '../components/ui';
import { api } from '../lib/api';
import { useLive, useNow } from '../lib/live';
import type { ActivityType, Overview } from '../lib/types';

const STATUS_LABEL = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  awaiting_qr: 'Waiting for QR scan',
  awaiting_pairing: 'Waiting for pairing code',
  connected: 'Connected',
  reconnecting: 'Reconnecting…'
} as const;

const HEADLINE_STATS: ActivityType[] = ['deleted', 'viewonce', 'ai', 'command', 'autoreply', 'call'];
const CHECKLIST_HIDDEN = 'bbot.checklist.hidden';

/** First-run guide: what to do, in order, with each step ticking itself off. */
function GettingStarted({ steps, onHide }: { steps: { title: string; hint: string; href: string; done: boolean }[]; onHide: () => void }) {
  const done = steps.filter(step => step.done).length;
  return (
    <section aria-labelledby="getting-started" className="rounded-xl border border-accent/40 bg-accent-soft/30 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="getting-started" className="font-semibold">
            Getting started
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            {done === steps.length ? 'All set. You can hide this guide.' : `${done} of ${steps.length} done. Work through these to get the most out of your bot.`}
          </p>
        </div>
        <button type="button" onClick={onHide} aria-label="Hide the getting started guide" className="rounded-lg p-1.5 text-muted hover:bg-panel hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="mt-4 grid gap-2 md:grid-cols-2">
        {steps.map((step, index) => (
          <li key={step.title}>
            <a href={step.href} className="flex items-start gap-3 rounded-lg bg-panel px-3 py-2.5 hover:bg-raised">
              <span
                className={cx(
                  'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  step.done ? 'bg-accent text-on-accent' : 'border border-line text-muted'
                )}
              >
                {step.done ? <Check className="h-3.5 w-3.5" aria-label="Done" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className={cx('block text-sm font-medium', step.done && 'text-muted line-through')}>{step.title}</span>
                <span className="block text-xs text-muted">{step.hint}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

function QuickToggle({
  icon: Icon,
  title,
  description,
  checked,
  onChange,
  href
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  href: string;
}) {
  return (
    <div className={cx('rounded-xl border p-4 transition-colors', checked ? 'border-accent/40 bg-accent-soft/40' : 'border-line bg-panel')}>
      <div className="flex items-center justify-between gap-3">
        <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', checked ? 'bg-accent text-on-accent' : 'bg-raised text-muted')}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={title}
          onClick={() => onChange(!checked)}
          className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line')}
        >
          <span className={cx('absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
        </button>
      </div>
      <a href={href} className="mt-3 block hover:underline">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted">{description}</span>
      </a>
    </div>
  );
}

export function OverviewPage() {
  const { session, settings, saveSettings, saveState, saveError, activity, online } = useLive();
  const now = useNow();
  const [overview, setOverview] = useState<Overview>();
  const [guideHidden, setGuideHidden] = useState(() => {
    try {
      return localStorage.getItem(CHECKLIST_HIDDEN) === '1';
    } catch {
      return false;
    }
  });
  const newest = activity[0]?.id;

  useEffect(() => {
    api<Overview>('/overview').then(setOverview).catch(() => {});
  }, [newest, session?.status]);

  if (!session || !settings) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> {online ? 'Loading…' : 'Connecting to the server…'}
      </div>
    );
  }

  const connected = session.status === 'connected';
  const rules = settings.autoReply.rules.filter(rule => rule.enabled).length;
  const privateMode = settings.commands.mode === 'private';
  const aiReady = Boolean(overview?.aiConfigured);
  const prefix = settings.commands.prefix;
  const steps = [
    { title: 'Link your WhatsApp', hint: 'Scan a QR code once. Takes a minute.', href: '#/connection', done: session.paired },
    {
      title: 'Turn on a protection',
      hint: 'Recover deleted messages, save view-once media, decline calls.',
      href: '#/protection',
      done: settings.antiDelete.enabled || settings.viewOnce.enabled || settings.calls.reject
    },
    { title: 'Set up the AI assistant', hint: 'Paste a free Google key and let it answer for you.', href: '#/assistant', done: aiReady && settings.ai.enabled },
    {
      title: 'Create a menu or an auto-reply',
      hint: 'Answer common questions without lifting a finger.',
      href: '#/menus',
      done: (overview?.counts.menus ?? 0) > 0 || settings.autoReply.rules.length > 0
    },
    { title: `Send ${prefix}menu to yourself`, hint: 'Open "Message yourself" in WhatsApp and try it.', href: '#/help', done: (overview?.stats.week.command ?? 0) > 0 },
    { title: 'Decide who can use the bot', hint: 'Public or private, and who is blocked.', href: '#/access', done: privateMode || settings.access.blockedUsers.length > 0 || settings.general.ownerNumbers.length > 0 }
  ];
  const hideGuide = () => {
    setGuideHidden(true);
    try {
      localStorage.setItem(CHECKLIST_HIDDEN, '1');
    } catch {
      // private browsing: it simply comes back next visit
    }
  };

  return (
    <>
      <PageHeader title="Overview" description="What your bot is doing, and the switches you reach for most." actions={<SaveIndicator state={saveState} error={saveError} />} />

      <div className="space-y-6">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={connected ? 'good' : session.status === 'disconnected' ? 'neutral' : 'warn'}>
                  <span className={cx('h-1.5 w-1.5 rounded-full bg-current', !connected && session.status !== 'disconnected' && 'animate-pulse')} />
                  {STATUS_LABEL[session.status]}
                </Badge>
                {session.me && (
                  <span className="truncate font-medium">
                    {session.me.name ? `${session.me.name} · ` : ''}+{session.me.phone}
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm text-muted">
                {connected && session.connectedAt
                  ? `Online for ${formatDuration((now - session.connectedAt) / 1000)}.`
                  : session.paired
                    ? (session.detail ?? 'The bot is not connected right now.')
                    : 'No WhatsApp account is linked yet.'}
                {overview && connected && ` Watching ${overview.counts.groups} groups, ${overview.counts.activeJobs} scheduled messages waiting.`}
              </p>
            </div>
            {!connected && (
              <a href="#/connection">
                <Button variant="primary" icon={<Plug className="h-4 w-4" />}>
                  {session.paired ? 'Go to connection' : 'Link WhatsApp'}
                </Button>
              </a>
            )}
          </div>
        </Card>

        {!online && <Notice tone="warn">Lost contact with the B-Bot server. Reconnecting…</Notice>}

        {!guideHidden && <GettingStarted steps={steps} onHide={hideGuide} />}

        <section aria-labelledby="quick-controls">
          <h2 id="quick-controls" className="mb-3 font-semibold">
            Quick controls
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <QuickToggle
              icon={Trash2}
              title="Anti-delete"
              description={settings.antiDelete.enabled ? 'Recovering deleted messages' : 'Deleted messages are lost'}
              checked={settings.antiDelete.enabled}
              onChange={enabled => saveSettings('antiDelete', { enabled })}
              href="#/protection"
            />
            <QuickToggle
              icon={Eye}
              title="Anti view-once"
              description={settings.viewOnce.enabled ? 'Saving view-once media' : 'View-once stays view-once'}
              checked={settings.viewOnce.enabled}
              onChange={enabled => saveSettings('viewOnce', { enabled })}
              href="#/protection"
            />
            <QuickToggle
              icon={Megaphone}
              title="Auto-view statuses"
              description={settings.status.autoView ? 'Statuses are marked as seen' : 'Statuses are left unseen'}
              checked={settings.status.autoView}
              onChange={autoView => saveSettings('status', { autoView })}
              href="#/protection"
            />
            <QuickToggle
              icon={PhoneOff}
              title="Reject calls"
              description={settings.calls.reject ? 'Incoming calls are declined' : 'Calls ring as normal'}
              checked={settings.calls.reject}
              onChange={reject => saveSettings('calls', { reject })}
              href="#/protection"
            />
            <QuickToggle
              icon={MessageSquareReply}
              title="Auto-replies"
              description={rules ? `${rules} keyword ${rules === 1 ? 'rule' : 'rules'}` : 'No rules yet'}
              checked={settings.autoReply.enabled}
              onChange={enabled => saveSettings('autoReply', { enabled })}
              href="#/replies"
            />
            <QuickToggle
              icon={Moon}
              title="Away message"
              description={settings.autoReply.awayEnabled ? 'Private chats get your away text' : 'Off'}
              checked={settings.autoReply.awayEnabled}
              onChange={awayEnabled => saveSettings('autoReply', { awayEnabled })}
              href="#/replies"
            />
            <QuickToggle
              icon={Sparkles}
              title="AI assistant"
              description={!aiReady ? 'Needs an API key first' : settings.ai.enabled ? 'Answering messages for you' : 'Off'}
              checked={aiReady && settings.ai.enabled}
              onChange={enabled => {
                // Without a key there is nothing to switch on: take them to the setup steps instead.
                if (!aiReady) location.hash = '#/assistant';
                else void saveSettings('ai', { enabled });
              }}
              href="#/assistant"
            />
            <QuickToggle
              icon={Lock}
              title="Private mode"
              description={privateMode ? 'Only owners can use the bot' : 'Anyone can use commands'}
              checked={privateMode}
              onChange={on => saveSettings('commands', { mode: on ? 'private' : 'public' })}
              href="#/access"
            />
          </div>
        </section>

        <section aria-labelledby="last-day">
          <h2 id="last-day" className="mb-3 font-semibold">
            Last 24 hours
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {HEADLINE_STATS.map(type => {
              const meta = ACTIVITY[type];
              const week = overview?.stats.week[type] ?? 0;
              return (
                <div key={type} className="rounded-xl border border-line bg-panel px-4 py-3">
                  <p className="flex items-center gap-1.5 text-xs text-muted">
                    <meta.icon className="h-3.5 w-3.5" aria-hidden />
                    {meta.label}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{overview ? (overview.stats.day[type] ?? 0) : '–'}</p>
                  <p className="text-xs text-muted">{week} this week</p>
                </div>
              );
            })}
          </div>
        </section>

        <Card
          title="Recent activity"
          actions={
            activity.length > 0 && (
              <a href="#/activity" className="flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                View all <ArrowRight className="h-3.5 w-3.5" />
              </a>
            )
          }
        >
          {activity.length === 0 ? (
            <p className="text-sm text-muted">
              Nothing yet. Recovered messages, removed links, declined calls and commands will show up here as they happen.
            </p>
          ) : (
            <div className="-my-3">
              <ActivityList entries={activity.slice(0, 8)} />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
