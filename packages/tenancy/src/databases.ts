import type { Connection, Model, Schema } from 'mongoose';
import { PLATFORM_TENANT_ID } from '@erp/contracts';
import { requireTenantId } from './context';

/** Where a tenant's data lives. `shared` is the default; `dedicated` gives the tenant its own database. */
export type Placement = { mode: 'shared' } | { mode: 'dedicated' };

export interface PlacementResolver {
  resolve(tenantId: string): Promise<Placement>;
}

/** Everyone in the shared database. Used by tests and by tenant-service for platform data. */
export const sharedPlacement: PlacementResolver = {
  resolve: async () => ({ mode: 'shared' }),
};

export interface ModelDef<T = unknown> {
  name: string;
  schema: Schema<T>;
}

export function dedicatedDbName(baseDbName: string, tenantId: string): string {
  return `${baseDbName}__${tenantId}`;
}

/**
 * Hands out models bound to the right database for the current tenant.
 * Services always get tenant models through this, never from a global connection.
 */
export class TenantDatabases {
  constructor(
    private readonly connection: Connection,
    private readonly baseDbName: string,
    private readonly resolver: PlacementResolver,
  ) {}

  /** Model for the tenant in the current context. */
  async model<T>(def: ModelDef<T>): Promise<Model<T>> {
    return this.modelFor(requireTenantId(), def);
  }

  async modelFor<T>(tenantId: string, def: ModelDef<T>): Promise<Model<T>> {
    const db = await this.dbFor(tenantId);
    return (db.models[def.name] as Model<T> | undefined) ?? db.model<T>(def.name, def.schema);
  }

  async dbFor(tenantId: string): Promise<Connection> {
    const placement =
      tenantId === PLATFORM_TENANT_ID
        ? ({ mode: 'shared' } as const)
        : await this.resolver.resolve(tenantId);
    const name =
      placement.mode === 'dedicated' ? dedicatedDbName(this.baseDbName, tenantId) : this.baseDbName;
    return name === this.connection.name
      ? this.connection
      : this.connection.useDb(name, { useCache: true });
  }

  /** The service's shared database, for platform-level collections (outbox, processed events). */
  get shared(): Connection {
    return this.connection;
  }
}
