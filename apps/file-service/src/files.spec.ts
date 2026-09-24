import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { signAccessToken, signServiceToken } from '@erp/auth';
import { PLACEMENT_RESOLVER, SharedPlacementResolver } from '@erp/service-kit';
import {
  fakeId,
  serviceTestEnv,
  startMongo,
  testKeys,
  TEST_INTERNAL_SECRET,
  type TestMongo,
} from '@erp/testing';
import { AppModule } from './app.module';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

describe('file-service', () => {
  let mongo: TestMongo;
  let app: INestApplication;
  let baseUrl = '';
  const http = () => request(baseUrl);
  const user = (tid: string) =>
    `Bearer ${signAccessToken({ sub: fakeId(5), tid, sid: 's', acl: [] }, testKeys().privateKey, 300)}`;

  beforeAll(async () => {
    mongo = await startMongo();
    Object.assign(
      process.env,
      serviceTestEnv(mongo.uri, 'erp_files_test', { STORAGE_DRIVER: 'memory', MAX_UPLOAD_MB: '1' }),
    );
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PLACEMENT_RESOLVER)
      .useClass(SharedPlacementResolver)
      .compile();
    app = ref.createNestApplication();
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
  });

  let fileId: string;

  it('uploads a file and serves it through a signed link', async () => {
    const up = await http()
      .post('/api/v1/files')
      .set('authorization', user('tA'))
      .attach('file', PNG, { filename: '../../photo<1>.png', contentType: 'image/png' })
      .expect(201);
    expect(up.body).toMatchObject({
      name: 'photo_1_.png',
      contentType: 'image/png',
      size: PNG.length,
    });
    fileId = up.body.id;

    const meta = await http()
      .get(`/api/v1/files/${fileId}`)
      .set('authorization', user('tA'))
      .expect(200);
    const res = await http()
      .get(meta.body.url)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses disallowed types, spoofed content and oversized files', async () => {
    await http()
      .post('/api/v1/files')
      .set('authorization', user('tA'))
      .attach('file', Buffer.from('<svg/>'), { filename: 'x.svg', contentType: 'image/svg+xml' })
      .expect(400);
    await http()
      .post('/api/v1/files')
      .set('authorization', user('tA'))
      .attach('file', Buffer.from('MZ....'), { filename: 'x.png', contentType: 'image/png' })
      .expect(400);
    await http()
      .post('/api/v1/files')
      .set('authorization', user('tA'))
      .attach('file', Buffer.alloc(2 * 1024 * 1024), {
        filename: 'big.txt',
        contentType: 'text/plain',
      })
      .expect(413);
    await http()
      .post('/api/v1/files')
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' })
      .expect(401);
  });

  it('rejects tampered, expired or cross-tenant links', async () => {
    const meta = await http()
      .get(`/api/v1/files/${fileId}`)
      .set('authorization', user('tA'))
      .expect(200);
    const url = new URL(meta.body.url, 'http://x');
    const tamper = (k: string, v: string) => {
      const u = new URL(url);
      u.searchParams.set(k, v);
      return `${u.pathname}${u.search}`;
    };
    await http().get(tamper('t', 'tB')).expect(403);
    await http()
      .get(tamper('exp', String(Math.floor(Date.now() / 1000) - 10)))
      .expect(403);
    await http()
      .get(tamper('sig', 'x'.repeat(43)))
      .expect(403);
    await http().get(`/api/v1/files/${fileId}/content`).expect(403);
  });

  it('keeps each tenant’s files private', async () => {
    await http().get(`/api/v1/files/${fileId}`).set('authorization', user('tB')).expect(404);
    const svcB = signServiceToken({ sub: 'svc:records-service', tid: 'tB' }, TEST_INTERNAL_SECRET);
    await http().get(`/internal/files/${fileId}`).set('x-service-token', svcB).expect(404);
    const svcA = signServiceToken({ sub: 'svc:records-service', tid: 'tA' }, TEST_INTERNAL_SECRET);
    await http().get(`/internal/files/${fileId}`).set('x-service-token', svcA).expect(200);
  });

  it('downloads non-image files as attachments', async () => {
    const up = await http()
      .post('/api/v1/files')
      .set('authorization', user('tA'))
      .attach('file', Buffer.from('a,b\n1,2\n'), { filename: 'data.csv', contentType: 'text/csv' })
      .expect(201);
    const meta = await http()
      .get(`/api/v1/files/${up.body.id}`)
      .set('authorization', user('tA'))
      .expect(200);
    const res = await http().get(meta.body.url).expect(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });
});
