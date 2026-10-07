import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useToast } from '../components/ui';
import { api, errorMessage } from './api';
import type { ActivityEntry, LogEntry, SessionSnapshot, Settings } from './types';

const MAX_LOGS = 1000;
const MAX_ACTIVITY = 200;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface LiveState {
  /** WebSocket to the server is open. */
  online: boolean;
  session?: SessionSnapshot;
  settings?: Settings;
  logs: LogEntry[];
  /** What the bot did recently, newest first. Kept current over the socket. */
  activity: ActivityEntry[];
  /** Bumped whenever jobs / chats change on the server; use as an effect dependency to refetch. */
  jobsVersion: number;
  directoryVersion: number;
}

interface LiveContextValue extends LiveState {
  /**
   * Change part of one settings section. Applied to the UI at once, then saved;
   * rolled back, with the server's reason shown, if the server refuses it.
   */
  saveSettings: <K extends keyof Settings>(section: K, patch: Partial<Settings[K]>) => Promise<boolean>;
  saveState: SaveState;
  saveError?: string;
  setSettings: (settings: Settings) => void;
  setSession: (session: SessionSnapshot) => void;
  clearLogs: () => void;
}

const LiveContext = createContext<LiveContextValue | undefined>(undefined);

type ServerEvent =
  | { type: 'hello'; data: { sessions: SessionSnapshot[]; logs: LogEntry[]; settings: Settings } }
  | { type: 'session'; data: SessionSnapshot }
  | { type: 'settings'; data: Settings }
  | { type: 'log'; data: LogEntry }
  | { type: 'activity'; data: ActivityEntry }
  | { type: 'jobs'; data: unknown }
  | { type: 'directory'; data: unknown };

/** One WebSocket for the whole dashboard: connection status, QR stream, settings and logs. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LiveState>({ online: false, logs: [], activity: [], jobsVersion: 0, directoryVersion: 0 });
  const [save, setSave] = useState<{ state: SaveState; error?: string }>({ state: 'idle' });
  const toast = useToast();
  const closedRef = useRef(false);
  const settingsRef = useRef<Settings | undefined>(undefined);
  settingsRef.current = state.settings;
  const pendingSaves = useRef(0);

  const saveSettings = useCallback(async <K extends keyof Settings>(section: K, patch: Partial<Settings[K]>) => {
    const before = settingsRef.current;
    if (!before) return false;
    const optimistic = { ...before, [section]: { ...before[section], ...patch } };
    settingsRef.current = optimistic;
    setState(prev => ({ ...prev, settings: optimistic }));
    pendingSaves.current++;
    setSave({ state: 'saving' });
    try {
      const saved = await api<Settings>('/settings', { method: 'PATCH', body: { [section]: patch } });
      pendingSaves.current--;
      if (pendingSaves.current === 0) {
        setState(prev => ({ ...prev, settings: saved }));
        setSave({ state: 'saved' });
      }
      return true;
    } catch (error) {
      pendingSaves.current--;
      // Put back what the server still has rather than guessing.
      const actual = await api<Settings>('/settings').catch(() => before);
      setState(prev => ({ ...prev, settings: actual }));
      setSave({ state: 'error', error: errorMessage(error) });
      toast(`Not saved: ${errorMessage(error)}`, 'danger');
      return false;
    }
  }, [toast]);

  useEffect(() => {
    closedRef.current = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let attempt = 0;

    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/api/ws`);
      socket.onopen = () => {
        attempt = 0;
        setState(prev => ({ ...prev, online: true }));
        api<ActivityEntry[]>(`/activity?limit=${MAX_ACTIVITY}`)
          .then(activity => setState(prev => ({ ...prev, activity })))
          .catch(() => {});
      };
      socket.onmessage = message => {
        const event = JSON.parse(message.data) as ServerEvent;
        setState(prev => {
          switch (event.type) {
            case 'hello':
              return { ...prev, session: event.data.sessions[0], logs: event.data.logs, settings: event.data.settings };
            case 'session':
              return { ...prev, session: event.data };
            case 'settings':
              // While a local change is in flight, its own response is the one to trust.
              return pendingSaves.current > 0 ? prev : { ...prev, settings: event.data };
            case 'log':
              return { ...prev, logs: [...prev.logs, event.data].slice(-MAX_LOGS) };
            case 'activity':
              if (prev.activity.some(entry => entry.id === event.data.id)) return prev;
              return { ...prev, activity: [event.data, ...prev.activity].slice(0, MAX_ACTIVITY) };
            case 'jobs':
              return { ...prev, jobsVersion: prev.jobsVersion + 1 };
            case 'directory':
              return { ...prev, directoryVersion: prev.directoryVersion + 1 };
            default:
              return prev;
          }
        });
      };
      socket.onclose = () => {
        setState(prev => ({ ...prev, online: false }));
        if (closedRef.current) return;
        attempt++;
        retry = window.setTimeout(connect, Math.min(1000 * 2 ** attempt, 15_000));
      };
    };
    connect();

    return () => {
      closedRef.current = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  const value = useMemo<LiveContextValue>(
    () => ({
      ...state,
      saveSettings,
      saveState: save.state,
      saveError: save.error,
      setSettings: settings => setState(prev => ({ ...prev, settings })),
      setSession: session => setState(prev => ({ ...prev, session })),
      clearLogs: () => setState(prev => ({ ...prev, logs: [] }))
    }),
    [state, save, saveSettings]
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const value = useContext(LiveContext);
  if (!value) throw new Error('useLive must be used inside <LiveProvider>');
  return value;
}

/** Re-renders on an interval and returns the current time; drives countdowns. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
