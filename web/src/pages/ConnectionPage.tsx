import { Check, Copy, KeyRound, LogOut, Plug, QrCode, RefreshCw, Send, Unplug } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, Spinner, cx, formatDateTime, formatDuration, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useLive, useNow } from '../lib/live';
import type { SessionSnapshot, SessionStatus } from '../lib/types';

const STATUS: Record<SessionStatus, { label: string; tone: 'neutral' | 'good' | 'warn' | 'danger' }> = {
  disconnected: { label: 'Disconnected', tone: 'neutral' },
  connecting: { label: 'Connecting…', tone: 'warn' },
  awaiting_qr: { label: 'Waiting for QR scan', tone: 'warn' },
  awaiting_pairing: { label: 'Waiting for pairing code', tone: 'warn' },
  connected: { label: 'Connected', tone: 'good' },
  reconnecting: { label: 'Reconnecting…', tone: 'warn' }
};

function Countdown({ until, total, label }: { until: number; total: number; label: string }) {
  const now = useNow(250);
  const left = Math.max(0, until - now);
  return (
    <div className="w-full max-w-xs">
      <div className="h-1.5 overflow-hidden rounded-full bg-raised">
        <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
      </div>
      <p className="mt-2 text-center text-xs text-muted" aria-live="off">
        {label} {Math.ceil(left / 1000)}s
      </p>
    </div>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2 text-sm">
      {items.map((item, index) => (
        <li key={item} className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
            {index + 1}
          </span>
          <span className="pt-0.5">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function PairingPanel({ session, act, busy }: { session: SessionSnapshot; act: Act; busy: string | null }) {
  const [tab, setTab] = useState<'qr' | 'pairing'>(session.method);
  const [phone, setPhone] = useState('');
  const [copied, setCopied] = useState(false);
  const waiting = session.status === 'awaiting_qr' || session.status === 'awaiting_pairing' || session.status === 'connecting';
  // While a code is live, show the tab it belongs to.
  const active = waiting ? session.method : tab;

  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code.replace('-', '')).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Card title="Link a device" description="Connect B-Bot to your WhatsApp account. Your phone stays the primary device.">
      <div role="tablist" className="mb-5 inline-flex rounded-lg bg-raised p-1">
        {(
          [
            ['qr', 'QR code', QrCode],
            ['pairing', 'Pairing code', KeyRound]
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active === key}
            disabled={waiting}
            onClick={() => setTab(key)}
            className={cx(
              'flex items-center gap-2 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed',
              active === key ? 'bg-panel shadow-sm' : 'text-muted hover:text-ink'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-8 md:grid-cols-[minmax(0,320px)_1fr]">
        <div className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-xl border border-line bg-raised/50 p-5">
          {session.status === 'connecting' && (
            <>
              <Spinner className="h-6 w-6 text-accent" />
              <p className="text-sm text-muted">Contacting WhatsApp…</p>
            </>
          )}

          {session.status === 'awaiting_qr' && session.qr && (
            <>
              <img src={session.qr.dataUrl} alt="WhatsApp pairing QR code" className="w-full max-w-64 rounded-lg bg-white p-2" />
              <Countdown key={session.qr.seq} until={session.qr.expiresAt} total={session.qr.seq === 1 ? 60_000 : 20_000} label="New code in" />
            </>
          )}

          {session.status === 'awaiting_pairing' && session.pairing && (
            <>
              <p className="text-sm text-muted">Code for +{session.pairing.phone}</p>
              <p className="font-mono text-3xl font-semibold tracking-[0.2em] select-all">{session.pairing.code}</p>
              <Button size="sm" onClick={() => copy(session.pairing!.code)} icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}>
                {copied ? 'Copied' : 'Copy code'}
              </Button>
              <Countdown until={session.pairing.expiresAt} total={160_000} label="Expires in about" />
            </>
          )}

          {!waiting && active === 'qr' && (
            <>
              <QrCode className="h-12 w-12 text-muted" aria-hidden />
              <Button variant="primary" busy={busy === 'start'} onClick={() => act('start', { method: 'qr' })}>
                Generate QR code
              </Button>
            </>
          )}

          {!waiting && active === 'pairing' && (
            <form
              className="w-full space-y-3"
              onSubmit={event => {
                event.preventDefault();
                void act('start', { method: 'pairing', phone });
              }}
            >
              <Field label="Phone number" hint="Country code first, digits only. Example: 15551234567">
                <Input inputMode="numeric" autoComplete="tel" placeholder="15551234567" value={phone} onChange={event => setPhone(event.target.value)} />
              </Field>
              <Button type="submit" variant="primary" className="w-full" busy={busy === 'start'} disabled={phone.replace(/\D/g, '').length < 7}>
                Get pairing code
              </Button>
            </form>
          )}

          {waiting && (
            <Button variant="ghost" size="sm" busy={busy === 'stop'} onClick={() => act('stop')}>
              Cancel
            </Button>
          )}
        </div>

        <div className="space-y-4">
          <h3 className="font-medium">On your phone</h3>
          {active === 'qr' ? (
            <Steps
              items={[
                'Open WhatsApp and go to Settings (or the ⋮ menu).',
                'Tap Linked devices, then Link a device.',
                'Point the camera at the QR code shown here.'
              ]}
            />
          ) : (
            <Steps
              items={[
                'Open WhatsApp and go to Settings (or the ⋮ menu).',
                'Tap Linked devices, then Link a device.',
                'Choose "Link with phone number instead" and type the 8-character code.'
              ]}
            />
          )}
          <p className="text-sm text-muted">
            The QR code refreshes on its own. If it times out, generate a new one. Nothing is sent to anyone but WhatsApp.
          </p>
        </div>
      </div>
    </Card>
  );
}

type Act = (action: 'start' | 'stop' | 'logout', body?: unknown) => Promise<void>;

export function ConnectionPage() {
  const { session, setSession, online } = useLive();
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  if (!session) {
    return (
      <div className="flex items-center gap-3 text-muted">
        <Spinner /> {online ? 'Loading…' : 'Connecting to the server…'}
      </div>
    );
  }

  const act: Act = async (action, body) => {
    setBusy(action);
    try {
      setSession(await api<SessionSnapshot>(`/sessions/${session.id}/${action}`, { method: 'POST', body: body ?? {} }));
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setBusy(null);
      setConfirmLogout(false);
    }
  };

  const sendTest = async () => {
    setBusy('test');
    try {
      await api(`/sessions/${session.id}/send`, { body: { to: 'alert', text: '✅ B-Bot is connected and can send messages.' } });
      toast('Test message sent to your alert chat.');
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      setBusy(null);
    }
  };

  const status = STATUS[session.status];
  const showPairing = !session.paired && session.status !== 'reconnecting';

  return (
    <>
      <PageHeader title="Connection" description="Link your WhatsApp account and keep an eye on the bot's connection." />

      <div className="space-y-6">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={status.tone}>
                  <span className={cx('h-1.5 w-1.5 rounded-full bg-current', status.tone === 'warn' && 'animate-pulse')} />
                  {status.label}
                </Badge>
                {session.me && (
                  <span className="truncate font-medium">
                    {session.me.name ? `${session.me.name} · ` : ''}+{session.me.phone}
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm text-muted">
                {session.status === 'connected' && session.connectedAt && `Online for ${formatDuration((now - session.connectedAt) / 1000)}.`}
                {session.status === 'reconnecting' &&
                  session.retry &&
                  `Attempt ${session.retry.attempt}, retrying in ${Math.max(0, Math.ceil((session.retry.nextAt - now) / 1000))}s. `}
                {session.detail}
                {session.status === 'disconnected' && !session.detail && (session.paired ? 'The bot is stopped.' : 'No device is linked yet.')}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {session.status === 'connected' && (
                <Button busy={busy === 'test'} onClick={sendTest} icon={<Send className="h-4 w-4" />}>
                  Send test message
                </Button>
              )}
              {session.paired && session.status === 'disconnected' && (
                <Button variant="primary" busy={busy === 'start'} onClick={() => act('start')} icon={<Plug className="h-4 w-4" />}>
                  Connect
                </Button>
              )}
              {session.status === 'reconnecting' && (
                <Button busy={busy === 'start'} onClick={() => act('start')} icon={<RefreshCw className="h-4 w-4" />}>
                  Retry now
                </Button>
              )}
              {session.paired && session.status !== 'disconnected' && (
                <Button busy={busy === 'stop'} onClick={() => act('stop')} icon={<Unplug className="h-4 w-4" />}>
                  Stop
                </Button>
              )}
              {session.paired &&
                (confirmLogout ? (
                  <>
                    <Button variant="danger" busy={busy === 'logout'} onClick={() => act('logout')}>
                      Yes, unlink this device
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmLogout(false)}>
                      Keep it
                    </Button>
                  </>
                ) : (
                  <Button variant="danger" onClick={() => setConfirmLogout(true)} icon={<LogOut className="h-4 w-4" />}>
                    Log out
                  </Button>
                ))}
            </div>
          </div>

          {session.lastDisconnect && session.status !== 'connected' && (
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              Last disconnect {formatDateTime(session.lastDisconnect.at)}: {session.lastDisconnect.reason}
              {session.lastDisconnect.code ? ` (code ${session.lastDisconnect.code})` : ''}
            </p>
          )}
        </Card>

        {!online && <Notice tone="warn">Lost contact with the B-Bot server. Reconnecting…</Notice>}

        {showPairing && <PairingPanel session={session} act={act} busy={busy} />}

      </div>
    </>
  );
}
