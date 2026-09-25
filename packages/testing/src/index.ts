import { generateKeyPairSync } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

export interface TestKeys {
  publicKey: string;
  privateKey: string;
}

let keys: TestKeys | undefined;

/** One RSA key pair per test process for signing access tokens. */
export function testKeys(): TestKeys {
  keys ??= generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return keys;
}

export const TEST_INTERNAL_SECRET = 'test-internal-secret-0123456789abcdef';

/** Environment for booting one service in-process against the in-memory database and bus. */
export function serviceTestEnv(
  mongoUri: string,
  db: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: '0',
    LOG_LEVEL: 'silent',
    MONGO_URI: mongoUri,
    MONGO_DB: db,
    NATS_URL: 'memory',
    JWT_PUBLIC_KEY: testKeys().publicKey,
    INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    TENANT_SERVICE_URL: 'http://127.0.0.1:9',
    ENABLE_DOCS: 'false',
    ...extra,
  };
}

export interface TestMongo {
  uri: string;
  stop(): Promise<void>;
}

/**
 * Starts an in-memory single-node MongoDB replica set. A replica set is
 * needed because services use multi-document transactions (outbox, audit).
 */
export async function startMongo(): Promise<TestMongo> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await replSet.waitUntilRunning();
  return {
    uri: replSet.getUri(),
    stop: () => replSet.stop().then(() => undefined),
  };
}

/** A 24-hex id that looks like a MongoDB ObjectId, for fixtures. */
export function fakeId(seed: number): string {
  return seed.toString(16).padStart(24, '0');
}
export * from './fake-oidc';
