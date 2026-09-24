import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { signAccessToken } from '@erp/auth';
import { subjectFor, type EventEnvelope, type PermissionKey } from '@erp/contracts';
import {
  MONGO_CONNECTION,
  PLACEMENT_RESOLVER,
  SharedPlacementResolver,
  sharedMemoryBus,
} from '@erp/service-kit';
import { serviceTestEnv, startMongo, testKeys, type TestMongo } from '@erp/testing';
import { AppModule } from './app.module';
import { canonicalJson, chainHash, redact } from './chain';
import type { AuditRecord } from './models';

const PERMS: PermissionKey[] = ['audit.event.read', 'audit.chain.verify'];

function event(tenantId: string, type: string, payload: unknown = {}): EventEnvelope {
  return {
    eventId: randomUUID(),
    type,
    version: 1,
    tenantId,
    actor: { type: 'user', id: 'u1' },
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    source: 'test',
    payload,
  };
}

describe('chain helpers', () => {
  it('produces the same JSON regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
  });

  it('redacts secret-looking fields but keeps ordinary ones', () => {
    expect(
      redact({ countryCode: 'IN', password: 'x', nested: { mfaToken: 't', code: '123456' } }),
    ).toEqual({
      countryCode: 'IN',
      password: '[redacted]',
      nested: { mfaToken: '[redacted]', code: '[redacted]' },
    });
  });
});

describe('audit-service', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let conn: Connection;
  const bus = sharedMemoryBus();
  const auth = (tid: string) =>
    `Bearer ${signAccessToken({ sub: 'u1', tid, sid: 's', acl: [{ ou: 'r', path: '/r/', p: PERMS }] }, testKeys().privateKey, 300)}`;
  const http = () => request(app.getHttpServer());

  async function emit(...events: EventEnvelope[]) {
    for (const e of events) await bus.publish(subjectFor(e.type), e, e.eventId);
    await bus.idle();
  }

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(process.env, serviceTestEnv(mongo.uri, 'erp_audit_test'));
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PLACEMENT_RESOLVER)
      .useClass(SharedPlacementResolver)
      .compile();
    app = ref.createNestApplication();
    await app.init();
    conn = app.get(MONGO_CONNECTION);
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  it('chains events per tenant and verifies them', async () => {
    const dup = event('tA', 'org.unit.created', { name: 'HQ' });
    await emit(dup, event('tA', 'identity.login.succeeded'), event('tB', 'org.unit.created'), dup);

    const a = await http().get('/api/v1/audit/events').set('authorization', auth('tA')).expect(200);
    expect(a.body.total).toBe(2);
    expect(a.body.items.map((r: { seq: number }) => r.seq)).toEqual([2, 1]);
    const b = await http().get('/api/v1/audit/events').set('authorization', auth('tB')).expect(200);
    expect(b.body.total).toBe(1);

    const va = await http()
      .get('/api/v1/audit/verify')
      .set('authorization', auth('tA'))
      .expect(200);
    expect(va.body).toEqual({ valid: true, records: 2, headSeq: 2 });
  });

  it('does not record notification requests', async () => {
    await bus.publish(
      'notify.email.requested',
      event('tA', 'notify.email.requested', { to: 'x' }),
      randomUUID(),
    );
    await bus.idle();
    const a = await http().get('/api/v1/audit/events').set('authorization', auth('tA')).expect(200);
    expect(a.body.items.some((r: { type: string }) => r.type.startsWith('notify.'))).toBe(false);
  });

  it('detects an edited record', async () => {
    await emit(event('tC', 'x.one'), event('tC', 'x.two', { amount: 100 }), event('tC', 'x.three'));
    await conn
      .collection('audit_records')
      .updateOne({ tenantId: 'tC', seq: 2 }, { $set: { 'payload.amount': 1 } });
    const v = await http().get('/api/v1/audit/verify').set('authorization', auth('tC')).expect(200);
    expect(v.body).toMatchObject({
      valid: false,
      brokenAt: { seq: 2, reason: 'record content was changed' },
    });
  });

  it('detects a deleted record', async () => {
    await emit(event('tD', 'x.one'), event('tD', 'x.two'), event('tD', 'x.three'));
    await conn.collection('audit_records').deleteOne({ tenantId: 'tD', seq: 2 });
    const v = await http().get('/api/v1/audit/verify').set('authorization', auth('tD')).expect(200);
    expect(v.body).toMatchObject({ valid: false, brokenAt: { seq: 2, reason: 'missing record' } });
  });

  it('detects a removed tail', async () => {
    await emit(event('tE', 'x.one'), event('tE', 'x.two'));
    await conn.collection('audit_records').deleteOne({ tenantId: 'tE', seq: 2 });
    const v = await http().get('/api/v1/audit/verify').set('authorization', auth('tE')).expect(200);
    expect(v.body.valid).toBe(false);
  });

  it('detects a record rewritten with a recomputed hash', async () => {
    await emit(event('tF', 'x.one'), event('tF', 'x.two'), event('tF', 'x.three'));
    // An attacker who edits record 2 and recomputes its own hash still breaks record 3's link.
    const r2 = await conn
      .collection<AuditRecord>('audit_records')
      .findOne({ tenantId: 'tF', seq: 2 });
    const forged = { ...r2!, type: 'x.forged' };
    const hash = chainHash(forged.prevHash, {
      tenantId: forged.tenantId,
      seq: forged.seq,
      eventId: forged.eventId,
      type: forged.type,
      source: forged.source,
      actor: forged.actor,
      occurredAt: forged.occurredAt,
      recordedAt: forged.recordedAt,
      correlationId: forged.correlationId,
      payload: forged.payload,
    });
    await conn
      .collection('audit_records')
      .updateOne({ _id: r2!._id }, { $set: { type: 'x.forged', hash } });
    const v = await http().get('/api/v1/audit/verify').set('authorization', auth('tF')).expect(200);
    expect(v.body).toMatchObject({ valid: false, brokenAt: { seq: 3 } });
  });

  it('requires audit permissions', async () => {
    const noPerms = `Bearer ${signAccessToken({ sub: 'u1', tid: 'tA', sid: 's', acl: [] }, testKeys().privateKey, 300)}`;
    await http().get('/api/v1/audit/events').set('authorization', noPerms).expect(403);
  });
});
