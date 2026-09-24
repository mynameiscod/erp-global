import type { EffectiveConfig } from '@erp/metadata';
import { requireTenantId } from '@erp/tenancy';
import type { ServiceClient } from './service-client';

export interface TenantProfile {
  countryCode: string;
  currency: string;
  locale: string;
  defaultLanguage: string;
}

export type EffectiveConfigResponse = EffectiveConfig & { tenant: TenantProfile };

interface Entry {
  version: number;
  value: EffectiveConfigResponse;
}

/**
 * Reads published configuration from config-service.
 *
 * Every call asks for the tenant's current version number (a tiny, indexed
 * lookup) and reuses the cached configuration only if it is still that
 * version. A change is therefore visible immediately after it is published,
 * on every service, without waiting for events or cache expiry.
 */
export class ConfigClient {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<number>>();

  constructor(private readonly config: Pick<ServiceClient, 'get'>) {}

  private currentVersion(tenantId: string): Promise<number> {
    let p = this.inflight.get(tenantId);
    if (!p) {
      p = this.config
        .get<{ version: number }>('/internal/config/version')
        .then((r) => r.version)
        .finally(() => this.inflight.delete(tenantId));
      this.inflight.set(tenantId, p);
    }
    return p;
  }

  async effective(orgPath?: string): Promise<EffectiveConfigResponse> {
    const tenantId = requireTenantId();
    const key = `${tenantId}|${orgPath ?? ''}`;
    const version = await this.currentVersion(tenantId);
    const hit = this.cache.get(key);
    if (hit && hit.version === version) return hit.value;
    const value = await this.config.get<EffectiveConfigResponse>(
      `/internal/config/effective${orgPath ? `?orgPath=${encodeURIComponent(orgPath)}` : ''}`,
    );
    this.cache.set(key, { version: value.version, value });
    return value;
  }

  invalidate(tenantId: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${tenantId}|`)) this.cache.delete(key);
  }
}
