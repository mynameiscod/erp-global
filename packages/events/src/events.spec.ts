import mongoose, { Schema, type Connection } from 'mongoose';
import { startMongo, type TestMongo } from '@erp/testing';
import { getContext, runAsTenant, runWithoutTenant, tenantPlugin } from '@erp/tenancy';
import type { EventEnvelope } from '@erp/contracts';
import { InMemoryEventBus, subjectMatches } from './bus';
import { OutboxRelay, OutboxWriter, outboxModel } from './outbox';
import { ensureConsumerIndexes, handleOnce } from './consumer';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const actor = { type: 'user' as const, id: 'u1' };

describe('subjectMatches', () => {
  it('follows NATS wildcard rules', () => {
    expect(subjectMatches('erp.>', 'erp.org.unit.created')).toBe(true);
    expect(subjectMatches('erp.org.unit.*', 'erp.org.unit.created')).toBe(true);
    expect(subjectMatches('erp.org.*', 'erp.org.unit.created')).toBe(false);
    expect(subjectMatches('erp.>', 'notify.email.requested')).toBe(false);
  });
});

describe('outbox and consumers', () => {
  let mongo: TestMongo;
  let conn: Connection;
  const Note = new Schema({ text: String });
  Note.plugin(tenantPlugin);

  beforeAll(async () => {
    mongo = await startMongo();
    conn = await mongoose.createConnection(mongo.uri, { dbName: 'events_test' }).asPromise();
    await outboxModel(conn).init();
    await ensureConsumerIndexes(conn);
    await conn.model('Note', Note).init();
  });

  afterAll(async () => {
    await conn.close();
    await mongo.stop();
  });

  it('publishes only committed events, with context metadata', async () => {
    const writer = new OutboxWriter(conn, 'test-service');
    const bus = new InMemoryEventBus();
    const relay = new OutboxRelay(conn, bus, silent);

    await runAsTenant('tA', actor, () =>
      conn.transaction(async (session) => {
        await writer.record('org.unit.created', { id: 1 }, { session });
      }),
    );
    await expect(
      runAsTenant('tA', actor, () =>
        conn.transaction(async (session) => {
          await writer.record('org.unit.created', { id: 2 }, { session });
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');

    expect(await relay.flush()).toBe(1);
    expect(bus.published).toHaveLength(1);
    const [e] = bus.published;
    expect(e).toMatchObject({
      type: 'org.unit.created',
      tenantId: 'tA',
      actor,
      source: 'test-service',
      payload: { id: 1 },
    });
    expect(await relay.flush()).toBe(0);
  });

  it('runs handlers once, in the event tenant context', async () => {
    const Notes = conn.model('Note');
    const event: EventEnvelope = {
      eventId: 'e-1',
      type: 'x',
      version: 1,
      tenantId: 'tB',
      actor,
      occurredAt: new Date().toISOString(),
      source: 's',
      payload: {},
    };
    const seenTenants: (string | undefined)[] = [];
    const handler = async (session: mongoose.ClientSession) => {
      seenTenants.push(getContext()?.tenantId);
      await Notes.create([{ text: 'from-event' }], { session });
    };

    expect(await handleOnce(conn, 'c1', event, handler)).toBe('processed');
    expect(await handleOnce(conn, 'c1', event, handler)).toBe('duplicate');
    expect(await handleOnce(conn, 'c2', event, handler)).toBe('processed');
    expect(seenTenants).toEqual(['tB', 'tB']);

    const notes = await runWithoutTenant(() => Notes.find().lean());
    expect(notes.every((n) => n.tenantId === 'tB')).toBe(true);
    expect(await runAsTenant('tA', actor, () => Notes.countDocuments())).toBe(0);
  });

  it('rolls back a failed handler so the event can be retried', async () => {
    const event: EventEnvelope = {
      eventId: 'e-2',
      type: 'x',
      version: 1,
      tenantId: 'tB',
      actor,
      occurredAt: new Date().toISOString(),
      source: 's',
      payload: {},
    };
    await expect(
      handleOnce(conn, 'c1', event, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await handleOnce(conn, 'c1', event, async () => {})).toBe('processed');
  });
});
