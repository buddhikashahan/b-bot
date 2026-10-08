import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { AuthStatus } from '../lib/types';

export function Logo({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="glow flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-lg font-bold text-on-accent">B</span>
    </span>
  );
}

/** Sign-in screen; doubles as the first-run "choose a password" screen. */
export function LoginPage({ auth, onDone }: { auth: AuthStatus; onDone: () => void }) {
  const setup = auth.setupRequired;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (setup && password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(setup ? '/auth/setup' : '/auth/login', { body: { password } });
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      {/* Cover art beside the form on wide screens, cropped to a banner above it on phones. */}
      <div className="grid w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-panel md:max-w-3xl md:grid-cols-2">
        <img src="/cover.jpg" alt="B-Bot, your smart WhatsApp assistant" className="aspect-[16/10] w-full object-cover md:aspect-auto md:h-full" />
        <form onSubmit={submit} className="space-y-5 p-7 md:self-center">
          <div className="flex items-center gap-3">
            <Logo />
            <div>
              <h1 className="text-lg font-semibold">B-Bot</h1>
              <p className="text-sm text-muted">{setup ? 'Welcome! Choose a dashboard password.' : 'Sign in to your dashboard.'}</p>
            </div>
          </div>

          {setup && (
            <Notice>This password protects access to your WhatsApp bot. Anyone who has it can read recovered messages and send as you.</Notice>
          )}

          <Field label="Password" hint={setup ? `At least ${auth.minPasswordLength} characters.` : undefined}>
            <Input
              type="password"
              autoFocus
              autoComplete={setup ? 'new-password' : 'current-password'}
              minLength={setup ? auth.minPasswordLength : undefined}
              value={password}
              onChange={event => setPassword(event.target.value)}
              required
            />
          </Field>
          {setup && (
            <Field label="Repeat password">
              <Input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} required />
            </Field>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" className="w-full" busy={busy}>
            {setup ? 'Create password' : 'Sign in'}
          </Button>
        </form>
      </div>
    </main>
  );
}
