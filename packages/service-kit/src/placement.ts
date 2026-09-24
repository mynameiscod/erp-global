import { Injectable } from '@nestjs/common';
import type { Placement, PlacementResolver } from '@erp/tenancy';
import type { ServiceClient } from './service-client';

/** Asks tenant-service where a tenant's data lives, caching answers for a minute. */
export class HttpPlacementResolver implements PlacementResolver {
  private readonly cache = new Map<string, { value: Placement; expires: number }>();

  constructor(
    private readonly tenants: ServiceClient,
    private readonly ttlMs = 60_000,
  ) {}

  async resolve(tenantId: string): Promise<Placement> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await this.tenants.get<Placement>(
      `/internal/tenants/${encodeURIComponent(tenantId)}/placement`,
      {
        tenantId,
      },
    );
    this.cache.set(tenantId, { value, expires: Date.now() + this.ttlMs });
    return value;
  }
}

/** Every tenant in the shared database. For tests and single-tenant deployments. */
@Injectable()
export class SharedPlacementResolver implements PlacementResolver {
  async resolve(): Promise<Placement> {
    return { mode: 'shared' };
  }
}
