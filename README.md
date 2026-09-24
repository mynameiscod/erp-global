# global-erp

One configurable cloud ERP for any industry and any country, built as TypeScript MERN microservices
(MongoDB, Express/NestJS, React, Node). Behaviour comes from configuration, not code:

```
Core platform + Country Pack + Industry Pack + Client config (System Admin) = the client's ERP
```

**Status:** Step 1 (platform foundation) is done: multi-tenancy, a custom org hierarchy, identity and 2FA,
roles scoped to org units, a hash-chained audit log, reference data for every country, the web app
in English, Hindi and Arabic (RTL), Docker and CI. See [docs/architecture.md](docs/architecture.md).

## What's inside

| Path                          | What it is                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `apps/api-gateway`            | The only public API entry point: edge auth, rate limiting, routing                  |
| `apps/identity-service`       | Users, login, TOTP 2FA, sessions, invites, password reset                           |
| `apps/tenant-service`         | Company sign-up (saga), settings, platform admin, data placement                    |
| `apps/org-service`            | Org hierarchy of any depth (Group > Company > Region > Branch > …)                  |
| `apps/access-service`         | Roles, permissions, assignments scoped to org units                                 |
| `apps/audit-service`          | Tamper-evident, per-tenant hash-chained audit log                                   |
| `apps/reference-data-service` | Countries (~250), currencies, languages, time zones                                 |
| `apps/notification-service`   | Email in the user's language (SMTP)                                                 |
| `apps/web`                    | React + Bootstrap + AG Grid + React Hook Form; i18n with RTL                        |
| `packages/contracts`          | Shared types, permission catalog, event types, zod schemas (used by API and UI)     |
| `packages/tenancy`            | Request context + Mongoose tenant plugin (fails closed) + dedicated-DB routing      |
| `packages/auth`               | JWT (RS256 user, HS256 service) and NestJS guards                                   |
| `packages/events`             | Transactional outbox, NATS JetStream bus, idempotent consumers                      |
| `packages/service-kit`        | Shared NestJS bootstrap: config, context, DB, events, errors, logs, health, OpenAPI |
| `tests/e2e`                   | Step 1 acceptance test: every service + gateway, Tenant A vs Tenant B               |

## Local development

Needs Node 22+, pnpm 9 and Docker.

```bash
pnpm install
pnpm env:dev            # writes .env with fresh keys and prints the platform admin login
pnpm infra:up           # MongoDB (replica set), NATS, Redis, Mailpit
pnpm build
pnpm dev                # every service + gateway (:3000) + web (:5173)
```

Open http://localhost:5173 and create a company. Emails (invites, password resets) land in Mailpit
at http://localhost:8025. Each service serves its OpenAPI docs at `/docs` (for example
http://localhost:3003/docs for org-service).

To sign in as the Super Admin, use company `platform` with the email and password printed by `pnpm env:dev`.

## Tests

```bash
pnpm test               # unit + integration + end-to-end (in-memory MongoDB, no Docker needed)
pnpm test:e2e           # only the acceptance test
pnpm lint && pnpm typecheck && pnpm format:check
```

The acceptance test (`tests/e2e`) starts every service on real ports behind the real gateway and
checks the following:

- Tenant A and Tenant B can't reach each other's data through the API, the repository layer or background event processing.
- Tenant ids smuggled in headers or bodies are ignored, and forged tokens are rejected.
- Dedicated tenants get their own databases.
- Audit chains verify, and a tampered record is detected.

## Deploying (Hostinger VPS or any Docker host)

See [docs/deploy-hostinger.md](docs/deploy-hostinger.md). In short:

```bash
node infra/scripts/gen-env.mjs --prod     # .env.production with random secrets; edit APP_URL + SMTP
docker compose --env-file .env.production up -d --build
```
