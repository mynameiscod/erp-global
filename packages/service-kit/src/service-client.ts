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

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: CallOptions = {},
  ): Promise<T> {
    const ctx = getContext();
    const tid = opts.tenantId ?? ctx?.tenantId;
    const act = ctx?.actor?.type === 'user' ? ctx.actor.id : undefined;
    const token = signServiceToken({ sub: `svc:${this.callerName}`, tid, act }, this.secret);
    const headers: Record<string, string> = {
      [SERVICE_TOKEN_HEADER]: token,
      accept: 'application/json',
    };
    if (ctx?.correlationId) headers[CORRELATION_HEADER] = ctx.correlationId;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
    } catch {
      throw new UpstreamError(this.service, 503, undefined);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) throw new UpstreamError(this.service, res.status, json as ErrorBody | undefined);
    return json as T;
  }
}
