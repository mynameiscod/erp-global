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

/** For streaming requests that do not go through `api` (server-sent events). */
export function getAccessToken(): string | null {
  return accessToken;
}

export function refreshAccessToken(): Promise<string | null> {
  return refreshOnce();
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

/** A file from the API (a PDF), with its name from Content-Disposition. */
export async function apiBlob(
  path: string,
  opts: { method?: string; body?: unknown } = {},
  retried = false,
): Promise<{ blob: Blob; fileName: string }> {
  const headers: Record<string, string> = { 'accept-language': language };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection.');
  }
  if (res.status === 401 && !retried && (await refreshOnce())) return apiBlob(path, opts, true);
  if (!res.ok) {
    const json = (await res.json().catch(() => undefined)) as ErrorBody | undefined;
    throw new ApiError(
      res.status,
      json?.error?.code ?? 'ERROR',
      json?.error?.message ?? res.statusText,
      json?.error?.details,
    );
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  return { blob: await res.blob(), fileName: m ? decodeURIComponent(m[1]) : 'document.pdf' };
}

/** Saves a blob as a file in the browser. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Opens a blob (a PDF) in a new tab, where the browser can print it. */
export function openBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
}
