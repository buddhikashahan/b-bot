import { EventEmitter } from 'node:events';

/** Everything the dashboard receives over the WebSocket. */
export type LiveEvent =
  | { type: 'session'; data: unknown }
  | { type: 'log'; data: LogEntry }
  | { type: 'settings'; data: unknown }
  | { type: 'jobs'; data: { reason: string } }
  | { type: 'directory'; data: { reason: string } }
  | { type: 'activity'; data: ActivityEntry };

export type ActivityType =
  | 'deleted'
  | 'edited'
  | 'viewonce'
  | 'status'
  | 'antilink'
  | 'call'
  | 'command'
  | 'autoreply'
  | 'ai'
  | 'menu'
  | 'job'
  | 'member';

export interface ActivityEntry {
  id: string;
  type: ActivityType;
  title: string;
  detail: string | null;
  chat: string | null;
  createdAt: string;
}

export interface LogEntry {
  id: number;
  time: number;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  scope: string;
  msg: string;
}

class LiveBus extends EventEmitter {
  publish(event: LiveEvent): void {
    this.emit('event', event);
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

export const bus = new LiveBus();
bus.setMaxListeners(100);
