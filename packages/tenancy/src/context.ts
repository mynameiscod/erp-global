import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AclEntry, EventActor, PermissionKey } from '@erp/contracts';

/**
 * Everything a service knows about the current unit of work: an HTTP request,
 * an event being consumed or a background job. It is set once at the edge and
 * read everywhere below, so tenant scope never has to be passed by hand.
 */
export interface RequestContext {
  correlationId: string;
  tenantId?: string;
  actor?: EventActor;
  sessionId?: string;
  acl?: AclEntry[];
  plat?: PermissionKey[];
  /**
   * Allows tenant-plugged models to run without a tenant. Only for platform
   * maintenance code that is explicitly written to span tenants.
   */
  bypassTenant?: boolean;
}

export class TenantContextMissingError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING';
  constructor(message = 'No tenant in context: tenant data cannot be accessed') {
    super(message);
    this.name = 'TenantContextMissingError';
  }
}

export class TenantIsolationError extends Error {
  readonly code = 'TENANT_ISOLATION_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'TenantIsolationError';
  }
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) throw new TenantContextMissingError('No request context');
  return ctx;
}

export function requireTenantId(): string {
  const tenantId = storage.getStore()?.tenantId;
  if (!tenantId) throw new TenantContextMissingError();
  return tenantId;
}

/** Unwraps lazy thenables (e.g. Mongoose queries) so helpers return plain promises. */
type Settled<T> = T extends PromiseLike<infer U> ? Promise<U> : T;

/**
 * Runs `fn` in `ctx`. Mongoose queries are lazy and would otherwise execute
 * later, outside the context, when the caller awaits them. Thenables are
 * therefore started inside the context.
 */
function runSettled<T>(ctx: RequestContext, fn: () => T): Settled<T> {
  return storage.run(ctx, () => {
    const result = fn();
    if (
      result &&
      typeof (result as { then?: unknown }).then === 'function' &&
      !(result instanceof Promise)
    ) {
      return Promise.resolve(result) as Settled<T>;
    }
    return result as Settled<T>;
  });
}

/** Run `fn` as `tenantId`. For event consumers, jobs and saga steps. */
export function runAsTenant<T>(
  tenantId: string,
  actor: EventActor,
  fn: () => T,
  correlationId: string = getContext()?.correlationId ?? randomUUID(),
): Settled<T> {
  return runSettled({ correlationId, tenantId, actor }, fn);
}

/** Run `fn` with tenant scoping disabled. Use only for deliberate cross-tenant platform work. */
export function runWithoutTenant<T>(fn: () => T): Settled<T> {
  const parent = getContext();
  return runSettled(
    {
      correlationId: parent?.correlationId ?? randomUUID(),
      actor: parent?.actor,
      bypassTenant: true,
    },
    fn,
  );
}
