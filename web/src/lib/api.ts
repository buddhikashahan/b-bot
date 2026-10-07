export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Fired when any request comes back 401, so the app can drop to the login screen. */
export const UNAUTHORIZED_EVENT = 'bbot:unauthorized';

async function parse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => undefined);
  if (response.ok) return data as T;
  if (response.status === 401 && !response.url.includes('/api/auth/')) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  throw new ApiError(response.status, data?.error ?? `Request failed (${response.status})`);
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = options.body !== undefined;
  const response = await fetch(`/api${path}`, {
    method: options.method ?? (hasBody ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(options.body) : undefined
  });
  return parse<T>(response);
}

export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', body: form });
  return parse<T>(response);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
