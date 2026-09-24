import type { ErrorBody } from '@erp/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field errors from a VALIDATION_FAILED response, keyed by path. */
  fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    return Object.fromEntries(
      (this.details as { path: string; message: string }[]).map((d) => [d.path, d.message]),
    );
  }
}

let accessToken: string | null = null;
let refresher: (() => Promise<string | null>) | null = null;
let refreshing: Promise<string | null> | null = null;
let language = 'en';

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Registered by the auth provider: gets a fresh access token from the refresh cookie. */
export function setRefresher(fn: () => Promise<string | null>): void {
  refresher = fn;
}

export function setApiLanguage(lang: string): void {
  language = lang;
}

async function refreshOnce(): Promise<string | null> {
  if (!refresher) return null;
  refreshing ??= refresher().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Send the access token and retry once after a refresh on 401. */
  auth?: boolean;
}

/** Multipart upload (one file in the `file` field), with the same auth and error handling as `api`. */
export async function apiUpload<T>(path: string, file: File, retried = false): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'accept-language': language,
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: 'POST',
      headers,
      body,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 401 && !retried && (await refreshOnce()))
    return apiUpload<T>(path, file, true);
  const json = (await res.json().catch(() => undefined)) as unknown;
  if (!res.ok) {
    const e = (json as ErrorBody | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? res.statusText, e?.details);
  }
  return json as T;
}

export async function api<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const { method = 'GET', body, query, auth = true } = opts;
  const qs = query
    ? '?' +
      new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => [k, String(v)]),
      ).toString()
    : '';
  const headers: Record<string, string> = {
    accept: 'application/json',
    'accept-language': language,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}${qs}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection.');
  }

  if (res.status === 401 && auth && !retried) {
    const token = await refreshOnce();
    if (token) return api<T>(path, opts, true);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = (json as ErrorBody | undefined)?.error;
    throw new ApiError(
      res.status,
      e?.code ?? 'ERROR',
      e?.message ?? res.statusText,
      e?.details,
      (json as ErrorBody | undefined)?.correlationId,
    );
  }
  return json as T;
}
