import { signServiceToken, SERVICE_TOKEN_HEADER } from '@erp/auth';
import type { ErrorBody } from '@erp/contracts';
import { getContext } from '@erp/tenancy';
import { CORRELATION_HEADER } from './context.middleware';
import { UpstreamError } from './errors';

export interface CallOptions {
  /** Tenant the call acts for. Defaults to the current context tenant. */
  tenantId?: string;
  timeoutMs?: number;
}

/**
 * Calls another service's `/internal` API with a short-lived service token.
 * Tenant, acting user and correlation id travel with the call.
 */
export class ServiceClient {
  constructor(
    readonly service: string,
    private readonly baseUrl: string,
    private readonly callerName: string,
    private readonly secret: string,
  ) {}

  get<T>(path: string, opts?: CallOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }
  post<T>(path: string, body?: unknown, opts?: CallOptions): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }
  delete<T>(path: string, opts?: CallOptions): Promise<T> {
    return this.request<T>('DELETE', path, undefined, opts);
  }

  /** Sends raw bytes (a generated file) and reads a JSON answer. */
  postBytes<T>(path: string, bytes: Buffer, opts?: CallOptions): Promise<T> {
    return this.request<T>('POST', path, bytes, opts);
  }

  /** Reads raw bytes, e.g. a file's content. */
  async getBytes(
    path: string,
    opts: CallOptions = {},
  ): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.send('GET', path, undefined, opts, '*/*');
    if (!res.ok) {
      const text = await res.text();
      throw new UpstreamError(
        this.service,
        res.status,
        text ? (JSON.parse(text) as ErrorBody) : undefined,
      );
    }
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    opts: CallOptions,
    accept = 'application/json',
  ): Promise<Response> {
    const ctx = getContext();
    const tid = opts.tenantId ?? ctx?.tenantId;
    const act = ctx?.actor?.type === 'user' ? ctx.actor.id : undefined;
    const token = signServiceToken({ sub: `svc:${this.callerName}`, tid, act }, this.secret);
    const headers: Record<string, string> = { [SERVICE_TOKEN_HEADER]: token, accept };
    if (ctx?.correlationId) headers[CORRELATION_HEADER] = ctx.correlationId;
    const isBytes = Buffer.isBuffer(body);
    if (body !== undefined)
      headers['content-type'] = isBytes ? 'application/octet-stream' : 'application/json';
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : isBytes ? (body as Buffer) : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
    } catch {
      throw new UpstreamError(this.service, 503, undefined);
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: CallOptions = {},
  ): Promise<T> {
    const res = await this.send(method, path, body, opts);
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) throw new UpstreamError(this.service, res.status, json as ErrorBody | undefined);
    return json as T;
  }
}
