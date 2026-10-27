export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

let csrfPromise: Promise<void> | null = null;
function csrfToken(): string | null {
  return readCookie('__Host-mc_csrf') ?? readCookie('mc_csrf');
}
async function ensureCsrf() {
  if (csrfToken()) return;
  csrfPromise ??= fetch('/api/auth/csrf', { credentials: 'same-origin' }).then(() => undefined);
  await csrfPromise;
  csrfPromise = null;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') {
    await ensureCsrf();
    headers['x-csrf-token'] = csrfToken() ?? '';
    headers['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: method !== 'GET' ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: opts.signal,
    });
  } catch {
    throw new ApiError(0, 'Network error — check your connection and try again.');
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : {};
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.details);
  return data as T;
}

export const get = <T,>(p: string) => api<T>(p);
export const post = <T,>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body });
export const put = <T,>(p: string, body?: unknown) => api<T>(p, { method: 'PUT', body });
export const patch = <T,>(p: string, body?: unknown) => api<T>(p, { method: 'PATCH', body });
export const del = <T,>(p: string, body?: unknown) => api<T>(p, { method: 'DELETE', body });
