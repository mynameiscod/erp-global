// Generates an environment file with fresh secrets.
//   node infra/scripts/gen-env.mjs          -> .env             (local development)
//   node infra/scripts/gen-env.mjs --prod   -> .env.production  (docker compose on a server)
// Existing files are never overwritten.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const prod = process.argv.includes('--prod');
const root = join(import.meta.dirname, '..', '..');
const target = join(root, prod ? '.env.production' : '.env');
if (existsSync(target)) {
  console.error(`${target} already exists; not overwriting.`);
  process.exit(1);
}

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const b64 = (s) => Buffer.from(s).toString('base64');

const common = {
  JWT_PUBLIC_KEY: b64(publicKey),
  JWT_PRIVATE_KEY: b64(privateKey),
  INTERNAL_SECRET: secret(48),
  DATA_ENC_KEY: randomBytes(32).toString('base64'),
  PLATFORM_ADMIN_EMAIL: 'admin@example.com',
  PLATFORM_ADMIN_PASSWORD: secret(12),
};

const dev = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  MONGO_URI: 'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true',
  NATS_URL: 'nats://127.0.0.1:4222',
  REDIS_URL: 'redis://127.0.0.1:6379',
  TENANT_SERVICE_URL: 'http://127.0.0.1:3002',
  IDENTITY_SERVICE_URL: 'http://127.0.0.1:3001',
  ORG_SERVICE_URL: 'http://127.0.0.1:3003',
  ACCESS_SERVICE_URL: 'http://127.0.0.1:3004',
  AUDIT_SERVICE_URL: 'http://127.0.0.1:3005',
  REFERENCE_SERVICE_URL: 'http://127.0.0.1:3006',
  CONFIG_SERVICE_URL: 'http://127.0.0.1:3008',
  RECORDS_SERVICE_URL: 'http://127.0.0.1:3009',
  FILE_SERVICE_URL: 'http://127.0.0.1:3010',
  WORKFLOW_SERVICE_URL: 'http://127.0.0.1:3011',
  NOTIFICATION_SERVICE_URL: 'http://127.0.0.1:3007',
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'http://127.0.0.1:8333',
  S3_ACCESS_KEY: 'erp-files',
  S3_SECRET_KEY: 'erp-files-dev-secret',
  APP_URL: 'http://localhost:5173',
  CORS_ORIGINS: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  MAIL_FROM: 'global-erp <no-reply@localhost>',
  // Development: WhatsApp codes are printed in the notification-service log.
  WHATSAPP_PROVIDER: 'console',
  ENABLE_DOCS: 'true',
};

const production = {
  LOG_LEVEL: 'info',
  APP_URL: 'https://erp.example.com',
  HTTP_BIND: '127.0.0.1',
  HTTP_PORT: '8080',
  MONGO_ROOT_PASSWORD: secret(),
  MONGO_KEYFILE: randomBytes(96).toString('base64'),
  ...Object.fromEntries(
    [
      'IDENTITY',
      'TENANT',
      'ORG',
      'ACCESS',
      'AUDIT',
      'REFERENCE',
      'NOTIFICATION',
      'CONFIG',
      'RECORDS',
      'FILES',
      'WORKFLOW',
      'PROVISIONER',
    ].map((s) => [`MONGO_PASSWORD_${s}`, secret()]),
  ),
  REDIS_PASSWORD: secret(),
  S3_ACCESS_KEY: 'erp-files',
  S3_SECRET_KEY: secret(),
  SMTP_HOST: 'smtp.hostinger.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: 'no-reply@example.com',
  SMTP_PASS: 'change-me',
  MAIL_FROM: 'global-erp <no-reply@example.com>',
  // Optional sign-in providers. Leave empty to keep them off.
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  MICROSOFT_CLIENT_ID: '',
  MICROSOFT_CLIENT_SECRET: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  WHATSAPP_ACCESS_TOKEN: '',
  WHATSAPP_OTP_TEMPLATE: 'otp_code',
  WHATSAPP_TEMPLATE_LANGUAGES: 'en_US',
};

/** VAPID keys for web push: a P-256 key pair, base64url (public key uncompressed). */
function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x, 'base64url'),
    Buffer.from(pub.y, 'base64url'),
  ]);
  return { VAPID_PUBLIC_KEY: raw.toString('base64url'), VAPID_PRIVATE_KEY: priv.d };
}

const values = { ...(prod ? production : dev), ...common, ...vapidKeys() };
const header = prod
  ? '# Production secrets. Keep this file private (chmod 600) and back it up securely.\n# Edit APP_URL, PLATFORM_ADMIN_EMAIL and the SMTP settings before the first start.\n'
  : '# Local development settings. Generated; safe to delete and regenerate.\n';
writeFileSync(
  target,
  header +
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') +
    '\n',
  { mode: 0o600 },
);
console.log(`Wrote ${target}`);
console.log(
  `Platform admin: ${values.PLATFORM_ADMIN_EMAIL} / ${values.PLATFORM_ADMIN_PASSWORD} (sign in with company "platform")`,
);
