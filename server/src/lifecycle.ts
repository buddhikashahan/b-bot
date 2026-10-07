type ExitHandler = (code: number) => Promise<void>;

let handler: ExitHandler | undefined;

/** index.ts registers the graceful shutdown routine here so routes can trigger it. */
export function onExitRequested(fn: ExitHandler): void {
  handler = fn;
}

export function requestExit(code: number): void {
  if (handler) void handler(code);
  else process.exit(code);
}
