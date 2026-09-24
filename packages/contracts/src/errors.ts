export const ErrorCodes = {
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthenticated: 'UNAUTHENTICATED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  RateLimited: 'RATE_LIMITED',
  TenantMissing: 'TENANT_CONTEXT_MISSING',
  TenantSuspended: 'TENANT_SUSPENDED',
  MfaRequired: 'MFA_REQUIRED',
  Internal: 'INTERNAL_ERROR',
  Upstream: 'UPSTREAM_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    details?: unknown;
  };
  correlationId?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
