import { Writable } from 'node:stream';
import pino from 'pino';
import pretty from 'pino-pretty';
import { bus, type LogEntry } from './bus.js';
import { config } from './config.js';

const LEVELS: Record<number, LogEntry['level']> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal'
};
const BUFFER_SIZE = 500;
const buffer: LogEntry[] = [];
let nextId = 1;

/** Tees every log line into a ring buffer and onto the live bus for the dashboard. */
const capture = new Writable({
  write(chunk, _encoding, callback) {
    for (const line of chunk.toString().split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        let msg: string = record.msg ?? '';
        const detail = record.err?.message ?? record.error?.message;
        if (detail && !msg.includes(detail)) msg = msg ? `${msg}: ${detail}` : detail;
        const entry: LogEntry = {
          id: nextId++,
          time: record.time ?? Date.now(),
          level: LEVELS[record.level] ?? 'info',
          scope: record.mod ?? 'app',
          msg
        };
        buffer.push(entry);
        if (buffer.length > BUFFER_SIZE) buffer.shift();
        bus.publish({ type: 'log', data: entry });
      } catch {
        // not a JSON log line; nothing to capture
      }
    }
    callback();
  }
});

const output = config.isProduction
  ? process.stdout
  : pretty({ colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,mod', messageFormat: '[{mod}] {msg}' });

export const logger = pino(
  { level: config.logLevel, base: undefined },
  pino.multistream([
    { level: config.logLevel as pino.Level, stream: output },
    { level: config.logLevel as pino.Level, stream: capture }
  ])
);

export function scoped(mod: string): pino.Logger {
  return logger.child({ mod });
}

export function recentLogs(): LogEntry[] {
  return buffer.slice();
}
