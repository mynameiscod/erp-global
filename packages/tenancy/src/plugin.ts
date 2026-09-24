import type { Aggregate, MongooseQueryMiddleware, PipelineStage, Query, Schema } from 'mongoose';
import { getContext, requireTenantId, TenantIsolationError } from './context';

export const TENANT_FIELD = 'tenantId';

const FILTERED_QUERY_OPS = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
] as const;

/** Stages that read other collections and would escape the tenant filter. */
const FORBIDDEN_STAGES = [
  '$lookup',
  '$graphLookup',
  '$unionWith',
  '$out',
  '$merge',
  '$geoNear',
  '$search',
  '$searchMeta',
  '$vectorSearch',
];

function bypass(): boolean {
  return getContext()?.bypassTenant === true;
}

function assertSameTenant(value: unknown, tenantId: string, where: string): void {
  if (value !== undefined && value !== tenantId) {
    throw new TenantIsolationError(`${where}: ${TENANT_FIELD} does not match the current tenant`);
  }
}

function guardUpdate(update: unknown, tenantId: string): void {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return;
  const u = update as Record<string, Record<string, unknown> | unknown>;
  assertSameTenant(u[TENANT_FIELD], tenantId, 'update');
  for (const op of ['$set', '$setOnInsert']) {
    const part = u[op] as Record<string, unknown> | undefined;
    if (part) assertSameTenant(part[TENANT_FIELD], tenantId, `update ${op}`);
  }
  for (const op of [
    '$unset',
    '$rename',
    '$inc',
    '$push',
    '$pull',
    '$addToSet',
    '$pop',
    '$min',
    '$max',
    '$mul',
    '$currentDate',
  ]) {
    const part = u[op] as Record<string, unknown> | undefined;
    if (part && TENANT_FIELD in part) {
      throw new TenantIsolationError(`update ${op}: ${TENANT_FIELD} cannot be changed`);
    }
  }
}

function scopeFilter(
  filter: Record<string, unknown> | undefined,
  tenantId: string,
  where: string,
): Record<string, unknown> {
  assertSameTenant(filter?.[TENANT_FIELD], tenantId, where);
  return { ...(filter ?? {}), [TENANT_FIELD]: tenantId };
}

type BulkOp = Record<string, Record<string, unknown>>;

/**
 * Makes a schema tenant-scoped. Every read, write, count, aggregate and bulk
 * operation is limited to the tenant in the current context, and fails if no
 * tenant is set. This is the main isolation control for shared databases.
 */
export function tenantPlugin(schema: Schema): void {
  schema.add({
    [TENANT_FIELD]: { type: String, required: true, immutable: true, index: true },
  });

  schema.pre(
    FILTERED_QUERY_OPS as unknown as MongooseQueryMiddleware[],
    function (this: Query<unknown, unknown>) {
      if (bypass()) return;
      const tenantId = requireTenantId();
      const filter = this.getFilter() as Record<string, unknown>;
      assertSameTenant(
        filter[TENANT_FIELD],
        tenantId,
        `${(this as unknown as { op?: string }).op ?? 'query'} filter`,
      );
      this.where({ [TENANT_FIELD]: tenantId });
      guardUpdate(this.getUpdate(), tenantId);
    },
  );

  schema.pre('estimatedDocumentCount', function () {
    if (bypass()) return;
    throw new TenantIsolationError('estimatedDocumentCount is not tenant-safe; use countDocuments');
  });

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    if (bypass()) return;
    const tenantId = requireTenantId();
    const pipeline = this.pipeline();
    const stageNames = (stages: PipelineStage[]): string[] => stages.flatMap((s) => Object.keys(s));
    const bad = stageNames(pipeline).find((k) => FORBIDDEN_STAGES.includes(k));
    if (bad) throw new TenantIsolationError(`Aggregate stage ${bad} is not allowed on tenant data`);
    pipeline.unshift({ $match: { [TENANT_FIELD]: tenantId } });
  });

  schema.pre('validate', function (this: Record<string, unknown>) {
    const current = this[TENANT_FIELD];
    if (bypass() && current) return;
    const tenantId = requireTenantId();
    if (current === undefined || current === null) {
      this[TENANT_FIELD] = tenantId;
    } else {
      assertSameTenant(current, tenantId, 'save');
    }
  });

  schema.pre('save', function (this: Record<string, unknown>) {
    if (bypass()) return;
    assertSameTenant(this[TENANT_FIELD], requireTenantId(), 'save');
  });

  schema.pre('insertMany', function (next: (err?: Error) => void, docs: unknown) {
    try {
      if (!bypass()) {
        const tenantId = requireTenantId();
        const list = (Array.isArray(docs) ? docs : [docs]) as Record<string, unknown>[];
        for (const d of list) {
          if (d[TENANT_FIELD] === undefined) d[TENANT_FIELD] = tenantId;
          else assertSameTenant(d[TENANT_FIELD], tenantId, 'insertMany');
        }
      }
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  schema.pre('bulkWrite', function (next: (err?: Error) => void, ops: unknown) {
    try {
      if (!bypass()) {
        const tenantId = requireTenantId();
        for (const op of ops as BulkOp[]) {
          const [kind] = Object.keys(op);
          const body = op[kind];
          if (kind === 'insertOne') {
            const doc = body.document as Record<string, unknown>;
            if (doc[TENANT_FIELD] === undefined) doc[TENANT_FIELD] = tenantId;
            else assertSameTenant(doc[TENANT_FIELD], tenantId, 'bulkWrite insertOne');
          } else {
            body.filter = scopeFilter(
              body.filter as Record<string, unknown>,
              tenantId,
              `bulkWrite ${kind}`,
            );
            if (body.update) guardUpdate(body.update, tenantId);
            if (body.replacement) {
              const r = body.replacement as Record<string, unknown>;
              assertSameTenant(r[TENANT_FIELD], tenantId, 'bulkWrite replaceOne');
              r[TENANT_FIELD] = tenantId;
            }
          }
        }
      }
      next();
    } catch (err) {
      next(err as Error);
    }
  });
}
