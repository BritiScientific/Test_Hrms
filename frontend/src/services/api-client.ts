/**
 * Typed fetch wrapper for the HRMS API.
 *  - Same-origin requests; the session lives in an HttpOnly cookie the
 *    browser attaches automatically (JavaScript never sees the token).
 *  - Every request carries `X-HRMS-Client: web`: the server requires it on
 *    cookie-authenticated writes (CSRF guard) and uses it to deliver the
 *    session as a cookie instead of a bearer token.
 *  - Errors become ApiError with the server's code/message/details.
 */

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: any,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field errors from zod (422 VALIDATION_FAILED) or service-level fieldErrors. */
  get fieldErrors(): Record<string, string> {
    const fe = this.details?.fieldErrors;
    if (!fe || typeof fe !== 'object') return {};
    return Object.fromEntries(
      Object.entries(fe).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)]),
    );
  }
}

/** Codes meaning "your session is gone" (as opposed to "not signed in yet"). */
// UNAUTHENTICATED inside the signed-in app means the cookie is gone (absolute expiry, cleared elsewhere).
export const SESSION_LOST_CODES = new Set(['UNAUTHENTICATED', 'INVALID_TOKEN', 'SESSION_ENDED', 'MEMBERSHIP_INACTIVE']);

type Listener = (err: ApiError) => void;
const sessionListeners = new Set<Listener>();
export function onSessionLost(fn: Listener) {
  sessionListeners.add(fn);
  return () => {
    sessionListeners.delete(fn);
  };
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  raw?: Blob | ArrayBuffer;
  contentType?: string;
  signal?: AbortSignal;
  /** Do not broadcast a 401 as "session lost" (used by the initial /me probe). */
  silent401?: boolean;
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-hrms-client': 'web', accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) {
    body = opts.raw;
    headers['content-type'] = opts.contentType ?? 'application/octet-stream';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
  }

  if (res.status === 204) return undefined as T;
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const e = payload?.error;
    const err = new ApiError(
      res.status,
      e?.code ?? `HTTP_${res.status}`,
      e?.message ?? defaultMessage(res.status),
      e?.details,
      e?.requestId,
    );
    if (res.status === 401 && SESSION_LOST_CODES.has(err.code) && !opts.silent401) {
      sessionListeners.forEach((fn) => fn(err));
    }
    throw err;
  }
  return payload as T;
}

function defaultMessage(status: number) {
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'Not found.';
  if (status === 429) return 'Too many attempts. Please wait and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return 'Request failed.';
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => apiRequest<T>(path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>(path, { ...opts, method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  del: <T = void>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};

/** Query-string builder that drops empty values. */
export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}
