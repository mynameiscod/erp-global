import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Who "signs in" at the fake provider next. */
export interface FakeIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** Microsoft: directory (tenant) id; 9188040d-… means a personal account. */
  tid?: string;
  xms_edov?: boolean;
}

export interface FakeOidc {
  /** Base URL; Google's issuer is `${url}/google`, Microsoft's `${url}/microsoft`. */
  url: string;
  clientId: string;
  clientSecret: string;
  /** Sets the account used by the next /authorize call for that provider. */
  signInAs(provider: 'google' | 'microsoft', identity: FakeIdentity): void;
  /**
   * Plays the provider's part of the browser flow: takes the URL from /sso/.../start and
   * returns the callback URL (with code and state) the provider would redirect to.
   */
  authorize(authorizeUrl: string): Promise<string>;
  /** Tampers with the next ID token, e.g. `{ nonce: 'x' }` or `{ aud: 'other' }`. */
  tamperNext(claims: Record<string, unknown>): void;
  stop(): Promise<void>;
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A minimal OpenID Connect provider for tests: discovery, JWKS, /authorize and /token with
 * PKCE checks, issuing RS256 ID tokens. Microsoft's issuer is a `{tenantid}` template, like
 * the real multi-tenant endpoint.
 */
export async function startFakeOidc(): Promise<FakeOidc> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(6).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const clientId = 'test-client';
  const clientSecret = 'test-secret';
  const next: Record<string, FakeIdentity | undefined> = {};
  let tamper: Record<string, unknown> | undefined;
  const codes = new Map<
    string,
    {
      provider: string;
      identity: FakeIdentity;
      nonce: string;
      challenge: string;
      redirectUri: string;
    }
  >();
  let base = '';

  const issuerFor = (provider: string, tid?: string) =>
    provider === 'microsoft' ? `${base}/microsoft/${tid ?? '{tenantid}'}/v2.0` : `${base}/google`;

  const sign = (claims: Record<string, unknown>) => {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const payload = b64url(JSON.stringify(claims));
    const sig = createSign('RSA-SHA256').update(`${head}.${payload}`).sign(privateKey);
    return `${head}.${payload}.${b64url(sig)}`;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const [, provider, ...rest] = url.pathname.split('/');
    const path = rest.join('/');
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (provider !== 'google' && provider !== 'microsoft') return json(404, {});

    if (path === '.well-known/openid-configuration') {
      return json(200, {
        issuer: issuerFor(provider),
        authorization_endpoint: `${base}/${provider}/authorize`,
        token_endpoint: `${base}/${provider}/token`,
        jwks_uri: `${base}/${provider}/jwks`,
      });
    }
    if (path === 'jwks') return json(200, { keys: [jwk] });
    if (path === 'authorize') {
      const q = url.searchParams;
      const identity = next[provider];
      if (
        !identity ||
        q.get('client_id') !== clientId ||
        q.get('code_challenge_method') !== 'S256'
      ) {
        return json(400, { error: 'invalid_request' });
      }
      const code = randomBytes(12).toString('hex');
      codes.set(code, {
        provider,
        identity,
        nonce: q.get('nonce') ?? '',
        challenge: q.get('code_challenge') ?? '',
        redirectUri: q.get('redirect_uri') ?? '',
      });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (path === 'token' && req.method === 'POST') {
      const form = new URLSearchParams(await body(req));
      const entry = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (
        !entry ||
        entry.provider !== provider ||
        form.get('client_id') !== clientId ||
        form.get('client_secret') !== clientSecret ||
        form.get('redirect_uri') !== entry.redirectUri ||
        b64url(createHash('sha256').update(verifier).digest()) !== entry.challenge
      ) {
        return json(400, { error: 'invalid_grant' });
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: issuerFor(provider, entry.identity.tid),
        aud: clientId,
        iat: now,
        exp: now + 300,
        nonce: entry.nonce,
        ...entry.identity,
        ...tamper,
      };
      tamper = undefined;
      return json(200, { id_token: sign(claims), access_token: 'unused', token_type: 'Bearer' });
    }
    json(404, {});
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    clientId,
    clientSecret,
    signInAs: (provider, identity) => {
      next[provider] = identity;
    },
    tamperNext: (claims) => {
      tamper = claims;
    },
    async authorize(authorizeUrl) {
      const res = await fetch(authorizeUrl, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status !== 302 || !location) throw new Error(`fake authorize failed: ${res.status}`);
      return location;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
