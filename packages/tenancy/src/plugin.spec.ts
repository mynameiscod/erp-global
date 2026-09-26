import mongoose, { Schema, type Connection, type Model } from 'mongoose';
import { startMongo, type TestMongo } from '@erp/testing';
import {
  runAsTenant,
  runWithoutTenant,
  TenantContextMissingError,
  TenantIsolationError,
} from './context';
import { tenantPlugin } from './plugin';
import { TenantDatabases, dedicatedDbName, type PlacementResolver } from './databases';

interface Item {
  name: string;
  qty: number;
  tenantId?: string;
}

const A = 'tenant-a';
const B = 'tenant-b';
const actor = { type: 'system' as const, id: 'test' };
const asA = <T>(fn: () => T) => runAsTenant(A, actor, fn);
const asB = <T>(fn: () => T) => runAsTenant(B, actor, fn);

function itemSchema() {
  const s = new Schema<Item>({ name: String, qty: Number });
  s.plugin(tenantPlugin);
  return s;
}

describe('tenantPlugin', () => {
  let mongo: TestMongo;
  let conn: Connection;
  let Item: Model<Item>;

  beforeAll(async () => {
    mongo = await startMongo();
    conn = await mongoose.createConnection(mongo.uri, { dbName: 'plugin_test' }).asPromise();
    Item = conn.model<Item>('Item', itemSchema());
    await Item.init();
  });

  afterAll(async () => {
    await conn.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    await runWithoutTenant(() => Item.deleteMany({}));
    await asA(() => Item.create({ name: 'a-item', qty: 1 }));
    await asB(() => Item.create({ name: 'b-item', qty: 2 }));
  });

  it('stamps the tenant on create', async () => {
    const docs = await runWithoutTenant(() => Item.find().lean());
    expect(docs.map((d) => [d.name, d.tenantId]).sort()).toEqual([
      ['a-item', A],
      ['b-item', B],
    ]);
  });

  it('fails closed when no tenant is in context', async () => {
    await expect(Item.find()).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(Item.create({ name: 'x', qty: 0 })).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    await expect(Item.aggregate([{ $match: {} }])).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
  });

  it('scopes reads, counts and distinct', async () => {
    expect((await asA(() => Item.find())).map((d) => d.name)).toEqual(['a-item']);
    expect(await asA(() => Item.countDocuments())).toBe(1);
    expect(await asB(() => Item.distinct('name'))).toEqual(['b-item']);
    const bDoc = await asB(() => Item.findOne());
    expect(await asA(() => Item.findById(bDoc!._id))).toBeNull();
  });

  it('rejects a filter naming another tenant', async () => {
    await expect(asA(() => Item.find({ tenantId: B }))).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(asA(() => Item.find({ tenantId: { $in: [A, B] } }))).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it('scopes updates and deletes', async () => {
    const upd = await asA(() => Item.updateMany({}, { $set: { qty: 99 } }));
    expect(upd.modifiedCount).toBe(1);
    const del = await asA(() => Item.deleteMany({}));
    expect(del.deletedCount).toBe(1);
    const b = await asB(() => Item.findOne());
    expect(b?.qty).toBe(2);
  });

  it('cannot move a document to another tenant', async () => {
    await expect(asA(() => Item.updateOne({}, { $set: { tenantId: B } }))).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    await expect(asA(() => Item.updateOne({}, { $unset: { tenantId: 1 } }))).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it('upserts into the current tenant', async () => {
    await asA(() => Item.findOneAndUpdate({ name: 'new' }, { $set: { qty: 5 } }, { upsert: true }));
    const created = await runWithoutTenant(() => Item.findOne({ name: 'new' }).lean());
    expect(created?.tenantId).toBe(A);
  });

  it('will not save a document loaded for another tenant', async () => {
    const bDoc = await asB(() => Item.findOne());
    bDoc!.qty = 50;
    await expect(asA(() => bDoc!.save())).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('scopes aggregates and blocks cross-collection stages', async () => {
    const res = await asA(() =>
      Item.aggregate([{ $group: { _id: null, total: { $sum: '$qty' } } }]),
    );
    expect(res[0].total).toBe(1);
    await expect(
      asA(() =>
        Item.aggregate([
          { $lookup: { from: 'items', localField: 'x', foreignField: 'y', as: 'z' } },
        ]),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(asA(() => Item.aggregate([{ $unionWith: 'items' }]))).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
    // A lookup for another tenant, or hidden in a facet, is refused too.
    await expect(
      asA(() =>
        Item.aggregate([
          { $lookup: { from: 'items', pipeline: [{ $match: { tenantId: B } }], as: 'z' } },
        ]),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    await expect(
      asA(() => Item.aggregate([{ $facet: { x: [{ $unionWith: 'items' }] } }])),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('allows a lookup that matches the current tenant', async () => {
    const res = await asA(() =>
      Item.aggregate<{ others: unknown[] }>([
        { $limit: 1 },
        {
          $lookup: {
            from: Item.collection.collectionName,
            pipeline: [{ $match: { tenantId: A } }],
            as: 'others',
          },
        },
      ]),
    );
    expect(res[0].others.every((o) => (o as { tenantId: string }).tenantId === A)).toBe(true);
  });

  it('scopes insertMany, including lean inserts', async () => {
    await asA(() => Item.insertMany([{ name: 'm1', qty: 1 }], { lean: true }));
    const m1 = await runWithoutTenant(() => Item.findOne({ name: 'm1' }).lean());
    expect(m1?.tenantId).toBe(A);
    await expect(
      asA(() => Item.insertMany([{ name: 'm2', qty: 1, tenantId: B }], { lean: true })),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('scopes bulkWrite', async () => {
    await asA(() =>
      Item.bulkWrite([
        { insertOne: { document: { name: 'bulk', qty: 1 } } },
        { updateMany: { filter: {}, update: { $set: { qty: 7 } } } },
      ]),
    );
    const b = await asB(() => Item.find().lean());
    expect(b.map((d) => d.qty)).toEqual([2]);
    const bulk = await runWithoutTenant(() => Item.findOne({ name: 'bulk' }).lean());
    expect(bulk?.tenantId).toBe(A);
    await expect(
      asA(() => Item.bulkWrite([{ deleteMany: { filter: { tenantId: B } } }])),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  it('blocks estimatedDocumentCount', async () => {
    await expect(asA(() => Item.estimatedDocumentCount())).rejects.toBeInstanceOf(
      TenantIsolationError,
    );
  });

  it('keeps tenant context across async boundaries', async () => {
    const names = await asA(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return (await Item.find()).map((d) => d.name);
    });
    expect(names).toEqual(['a-item']);
  });
});

describe('TenantDatabases', () => {
  let mongo: TestMongo;
  let conn: Connection;

  beforeAll(async () => {
    mongo = await startMongo();
    conn = await mongoose.createConnection(mongo.uri, { dbName: 'erp_test' }).asPromise();
  });

  afterAll(async () => {
    await conn.close();
    await mongo.stop();
  });

  it('routes dedicated tenants to their own database', async () => {
    const resolver: PlacementResolver = {
      resolve: async (t) => (t === B ? { mode: 'dedicated' } : { mode: 'shared' }),
    };
    const dbs = new TenantDatabases(conn, 'erp_test', resolver);
    const def = { name: 'Item', schema: itemSchema() };

    await asA(async () => (await dbs.model(def)).create({ name: 'shared', qty: 1 }));
    await asB(async () => (await dbs.model(def)).create({ name: 'dedicated', qty: 1 }));

    const sharedNames = await conn.db!.collection('items').find().toArray();
    const dedicated = await conn
      .useDb(dedicatedDbName('erp_test', B))
      .db!.collection('items')
      .find()
      .toArray();
    expect(sharedNames.map((d) => d.name)).toEqual(['shared']);
    expect(dedicated.map((d) => d.name)).toEqual(['dedicated']);
    expect(dedicated[0].tenantId).toBe(B);
  });
});
