import {
  Activity,
  CalendarClock,
  CircleHelp,
  KeyRound,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu,
  MessageSquareReply,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Users,
  X,
  type LucideIcon
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Spinner, ToastProvider, cx } from './components/ui';
import { UNAUTHORIZED_EVENT, api } from './lib/api';
import { LiveProvider, useLive } from './lib/live';
import type { AuthStatus } from './lib/types';
import { AccessPage } from './pages/AccessPage';
import { AssistantPage } from './pages/AssistantPage';
import { ActivityPage } from './pages/ActivityPage';
import { AutoReplyPage } from './pages/AutoReplyPage';
import { CommandsPage } from './pages/CommandsPage';
import { ConnectionPage } from './pages/ConnectionPage';
import { GroupsPage } from './pages/GroupsPage';
import { HelpPage } from './pages/HelpPage';
import { LoginPage, Logo } from './pages/LoginPage';
import { LogsPage } from './pages/LogsPage';
import { MenusPage } from './pages/MenusPage';
import { OverviewPage } from './pages/OverviewPage';
import { ProtectionPage } from './pages/ProtectionPage';
import { SchedulerPage } from './pages/SchedulerPage';
import { SettingsPage } from './pages/SettingsPage';

interface PageDef {
  id: string;
  label: string;
  icon: LucideIcon;
  component: ComponentType;
  /** Sidebar heading this page sits under. */
  group?: string;
}

const PAGES: PageDef[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, component: OverviewPage },
  { id: 'connection', label: 'Connection', icon: Smartphone, component: ConnectionPage },
  { id: 'protection', label: 'Protection', icon: ShieldCheck, component: ProtectionPage, group: 'Automation' },
  { id: 'assistant', label: 'AI assistant', icon: Sparkles, component: AssistantPage, group: 'Automation' },
  { id: 'menus', label: 'Menus', icon: ListOrdered, component: MenusPage, group: 'Automation' },
  { id: 'replies', label: 'Auto-replies', icon: MessageSquareReply, component: AutoReplyPage, group: 'Automation' },
  { id: 'groups', label: 'Groups', icon: Users, component: GroupsPage, group: 'Automation' },
  { id: 'scheduler', label: 'Scheduler', icon: CalendarClock, component: SchedulerPage, group: 'Automation' },
  { id: 'access', label: 'Access', icon: KeyRound, component: AccessPage, group: 'Control' },
  { id: 'commands', label: 'Commands', icon: SquareTerminal, component: CommandsPage, group: 'Control' },
  { id: 'activity', label: 'Activity', icon: Activity, component: ActivityPage, group: 'System' },
  { id: 'logs', label: 'Logs', icon: ScrollText, component: LogsPage, group: 'System' },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, component: SettingsPage, group: 'System' },
  { id: 'help', label: 'Help', icon: CircleHelp, component: HelpPage, group: 'System' }
];

/** The current page lives in the URL hash so reloads and the back button work. */
function usePage(): string {
  const read = () => {
    const id = location.hash.replace(/^#\/?/, '');
    return PAGES.some(page => page.id === id) ? id : PAGES[0].id;
  };
  const [page, setPage] = useState(read);
  useEffect(() => {
    const onChange = () => setPage(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return page;
}

/** Brand, grouped page links and sign-out: shared by the desktop sidebar and the mobile drawer. */
function Navigation({ page, status, onSignOut, onClose }: { page: string; status: ReactNode; onSignOut: () => void; onClose?: () => void }) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 px-5 py-4 lg:py-5">
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          <div className="min-w-0 leading-tight">
            <p className="font-semibold">B-Bot</p>
            {status}
          </div>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close menu" className="rounded-lg p-2 text-muted hover:bg-raised hover:text-ink">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <nav aria-label="Main" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {PAGES.map((item, index) => (
          <Fragment key={item.id}>
            {item.group && item.group !== PAGES[index - 1]?.group && (
              <p className="px-3 pt-4 pb-1 text-xs font-semibold tracking-wide text-muted/80 uppercase">{item.group}</p>
            )}
            <a
              href={`#/${item.id}`}
              onClick={onClose}
              aria-current={item.id === page ? 'page' : undefined}
              className={cx(
                'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2',
                item.id === page ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-raised hover:text-ink'
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" aria-hidden />
              {item.label}
            </a>
          </Fragment>
        ))}
      </nav>

      <div className="border-t border-line p-3">
        <button
          type="button"
          onClick={onSignOut}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-muted hover:bg-raised hover:text-ink lg:py-2"
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </button>
      </div>
    </>
  );
}

function Shell({ onSignOut }: { onSignOut: () => void }) {
  const page = usePage();
  const { session } = useLive();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = PAGES.find(item => item.id === page)!;
  const Page = current.component;
  const dot =
    session?.status === 'connected' ? 'bg-accent' : session?.status === 'disconnected' || !session ? 'bg-muted' : 'animate-pulse bg-warn';
  const status = (
    <p className="flex items-center gap-1.5 truncate text-xs text-muted">
      <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      {session?.status === 'connected' ? `+${session.me?.phone ?? ''}` : (session?.status.replace('_', ' ') ?? 'offline')}
    </p>
  );

  // The drawer closes on navigation and on Escape, and the page behind it must not scroll.
  useEffect(() => setMenuOpen(false), [page]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Phones and tablets: a top bar with the page name, navigation in a drawer. */}
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-2 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
          className="rounded-lg p-2.5 text-ink hover:bg-raised"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate font-semibold">{current.label}</p>
          {status}
        </div>
        <Logo />
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" onClick={() => setMenuOpen(false)} className="absolute inset-0 h-full w-full cursor-default bg-black/50" />
          <aside className="relative flex h-full w-72 max-w-[85vw] flex-col bg-panel shadow-2xl">
            <Navigation page={page} status={status} onSignOut={onSignOut} onClose={() => setMenuOpen(false)} />
          </aside>
        </div>
      )}

      {/* Desktop: permanent sidebar. */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-panel lg:flex">
        <Navigation page={page} status={status} onSignOut={onSignOut} />
      </aside>

      <main className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className={cx('mx-auto max-w-5xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8', page === 'logs' && 'flex h-full flex-col')}>
          <Page />
        </div>
      </main>
    </div>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(() => {
    api<AuthStatus>('/auth/status')
      .then(status => {
        setAuth(status);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(UNAUTHORIZED_EVENT, refresh);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, refresh);
  }, [refresh]);

  // Keep retrying while the server is unreachable (e.g. mid-restart).
  useEffect(() => {
    if (!failed) return;
    const timer = window.setTimeout(refresh, 3000);
    return () => window.clearTimeout(timer);
  }, [failed, refresh]);

  const signOut = async () => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    refresh();
  };

  if (!auth) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-muted">
        <Spinner /> {failed ? 'Cannot reach the B-Bot server. Retrying…' : 'Loading…'}
      </div>
    );
  }

  return (
    <ToastProvider>
      {auth.authenticated ? (
        <LiveProvider>
          <Shell onSignOut={signOut} />
        </LiveProvider>
      ) : (
        <LoginPage auth={auth} onDone={refresh} />
      )}
    </ToastProvider>
  );
}
