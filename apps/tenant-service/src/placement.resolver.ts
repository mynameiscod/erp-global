import { Inject, Injectable } from '@nestjs/common';
import { Types, type Connection } from 'mongoose';
import { MONGO_CONNECTION } from '@erp/service-kit';
import type { Placement, PlacementResolver } from '@erp/tenancy';
import { tenantModel } from './tenant.model';

/** tenant-service answers placement from its own data. */
@Injectable()
export class LocalPlacementResolver implements PlacementResolver {
  private readonly cache = new Map<string, { value: Placement; expires: number }>();

  constructor(@Inject(MONGO_CONNECTION) private readonly conn: Connection) {}

  async resolve(tenantId: string): Promise<Placement> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expires > Date.now()) return hit.value;
    const t = Types.ObjectId.isValid(tenantId)
      ? await tenantModel(this.conn).findById(tenantId, { placement: 1 }).lean()
      : null;
    const value: Placement = { mode: t?.placement === 'dedicated' ? 'dedicated' : 'shared' };
    this.cache.set(tenantId, { value, expires: Date.now() + 60_000 });
    return value;
  }
}
