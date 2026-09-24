import { Redis } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { createGateway } from './app';
import { gatewayEnvSchema } from './config';

const parsed = gatewayEnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}
const env = parsed.data;

const redis = env.REDIS_URL ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 }) : undefined;
let storeCount = 0;
const app = createGateway(env, {
  rateLimitStore: redis
    ? () =>
        new RedisStore({
          prefix: `rl${storeCount++}:`,
          sendCommand: (command: string, ...args: string[]) =>
            redis.call(command, ...args) as Promise<RedisReply>,
        })
    : undefined,
});

const server = app.listen(env.PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 30, msg: `api-gateway listening on ${env.PORT}` }));
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      redis?.disconnect();
      process.exit(0);
    });
  });
}
