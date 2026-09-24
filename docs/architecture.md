# global-erp: Architecture

> Status: **Approved** by the owner on 2026-09-24 (full microservices). Step 1 is implemented; see section 13.

## 1. What we are building

One configurable cloud ERP (SaaS) for any industry and any country. Behaviour comes from **configuration**, not code:

```
Core platform  +  Country Pack  +  Industry Pack  +  Client config (System Admin)  =  the client's ERP
```

- **Country Pack**: currency, tax (GST/VAT/sales tax), invoice rules, payroll rules, payment gateways, holidays, formats.
- **Industry Pack**: modules, entities, fields, forms, workflows, reports and print templates for Education, Retail, Services, Healthcare and others.
- **Client config**: anything a System Admin changes for one client, with no developer involved.

No `if (country === 'IN')` or `if (industry === 'school')` in core code, ever.

## 2. Stack (decided)

| Layer                         | Choice                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Language                      | TypeScript everywhere                                                                        |
| Frontend                      | React + Vite, Bootstrap 5 (incl. RTL), AG Grid, React Hook Form + Zod, react-select, i18next |
| Backend                       | Node.js 22 LTS, NestJS (Express adapter), one NestJS app **per microservice**                |
| API                           | REST + OpenAPI (Swagger), versioned `/api/v1`                                                |
| Database                      | MongoDB 7 **replica set** (needed for transactions), Mongoose                                |
| Cache / sessions / rate limit | Redis 7                                                                                      |
| Messaging between services    | **NATS JetStream** (lightweight, durable events; much lighter than Kafka for a VPS)          |
| Reverse proxy / TLS           | Nginx + Let's Encrypt                                                                        |
| Containers                    | Docker + Docker Compose (Hostinger VPS); Kubernetes later if needed                          |
| Monorepo                      | pnpm workspaces + Turborepo                                                                  |
| CI                            | GitHub Actions                                                                               |
| Logs / tracing                | Pino JSON logs + OpenTelemetry (correlation id across services)                              |

## 3. Microservices

Every service owns **its own MongoDB database**. No service reads another service's database. Services talk only via REST (synchronous) or NATS events (asynchronous).

### Step 1 services (foundation)

| Service                  | Owns                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `api-gateway`            | Single public entry point: JWT verification, tenant resolution, rate limiting, routing, CORS      |
| `identity-service`       | Users, passwords (argon2), 2FA (TOTP), sessions, refresh tokens, invites. OTP/SSO added in Step 2 |
| `tenant-service`         | Tenants, sign-up, status, country/industry chosen, **database routing** (shared vs dedicated DB)  |
| `org-service`            | Custom org hierarchy of any depth (Group > Company > Region > Branch > Dept ...)                  |
| `access-service`         | Roles, permissions, scope by org unit, permission checks                                          |
| `audit-service`          | Tamper-evident **hash-chained** audit log                                                         |
| `reference-data-service` | Countries (~190), currencies, languages, timezones, number/date formats (from CLDR data)          |
| `notification-service`   | Email (SMTP) for invites, 2FA and password reset. SMS/WhatsApp later                              |
| `web`                    | React admin + app shell                                                                           |

### Later services (not in Step 1)

`config-service` (no-code fields/forms/entities/workflows/rules), `pack-service` (country/industry packs), `billing-service` (SaaS plans), `payment-service` (Razorpay/Stripe/PayPal... adapters), `crm`, `sales`, `accounting`, `inventory`, `purchase`, `hr`, `payroll`, `pos`, `projects`, `reporting`, `document-service` (PDF/print), `ai-service`.

## 4. Multi-tenancy (hybrid)

- **Shared mode (default):** tenant data lives in the service's shared database. Every document has `tenantId`.
- **Dedicated mode (per client, by config):** `tenant-service` stores a connection reference for the tenant, and each service opens a separate database for that tenant.

**How isolation is enforced.** MongoDB has no row-level security, so we use several layers:

1. The gateway resolves the tenant from the JWT and never trusts a tenant id sent by the client.
2. A shared `@erp/tenancy` library stores the tenant in async request context (AsyncLocalStorage). Background jobs and events carry it too.
3. A **Mongoose tenant plugin** adds `tenantId` to every query, update, aggregate and insert, and **throws** if no tenant is in context. Platform-level collections have to opt out explicitly.
4. A compound index starts with `tenantId` on every tenant collection.
5. Every service has its own MongoDB user, with rights only to its own database.
6. **Automated isolation tests:** Tenant A vs Tenant B through the API, the repository layer, background jobs and events. These are the Step 1 acceptance tests.

## 5. Security and access

- **JWT** access token (15 min) plus a rotating refresh token (stored hashed and revocable).
- Service-to-service calls use a separate internal token and run on the Docker internal network only. Only the gateway is exposed.
- **Admin levels:** Super Admin (platform) → Tenant Admin → roles the client defines. Permissions look like `module.entity.action` (e.g. `org.unit.create`) and are **scoped to an org unit and its children**.
- Passwords are hashed with argon2id. There's rate-limited login, account lockout, and optional TOTP 2FA per user, which a tenant can make mandatory.

## 6. Cross-service consistency

- **Transactional outbox:** a service writes its data change and its event in the same MongoDB transaction. A relay then publishes the event to NATS. No event is lost and none is sent for a failed write.
- **Idempotent consumers:** each event has an `eventId`, and consumers store the ids they've processed.
- **Sagas** for multi-service flows (e.g. tenant sign-up creates tenant, then root org unit, then admin user, then default roles), with compensating steps on failure.
- A standard event envelope: `eventId, type, version, tenantId, actor, occurredAt, correlationId, payload`.

## 7. Audit (hash chain)

Each sensitive change (users, roles, permissions, tenant settings, org changes and, later, finance postings) becomes an audit record:
`hash = SHA-256(previousHash + canonicalJSON(record))`, chained **per tenant**.
Records are append-only, and an endpoint verifies the chain to detect tampering.

## 8. Localisation (built in from day 1)

- Language, country and locale are **separate** settings. A user in the UAE can use the UI in English with AED currency.
- UI text lives in i18next translation files. RTL switches Bootstrap to `bootstrap.rtl.css` and sets `dir="rtl"`.
- Numbers, dates and currency are formatted with the browser/Node `Intl` API (e.g. Indian lakh grouping).
- Every date is stored in UTC, and each user has a timezone.
- Multilingual business data (e.g. item names in Arabic and English) comes in the config step.

## 9. Deployment on Hostinger

- **VPS size:** at least **KVM 2 (8 GB RAM)** for dev/staging. **KVM 4 (16 GB)** is recommended once real clients arrive, because full microservices run about 10+ containers.
- One `docker-compose.yml` runs everything: Nginx, gateway, services, MongoDB replica set, Redis and NATS.
- Nightly `mongodump` backups go to off-server storage (S3-compatible), with a documented restore test.
- **Portability:** there's nothing Hostinger-specific in the code. Moving to Atlas, AWS or anywhere else only needs changes to env/config.

## 10. Repository layout

```
global-erp/
  apps/
    web/                      React app
    api-gateway/
    identity-service/
    tenant-service/
    org-service/
    access-service/
    audit-service/
    reference-data-service/
    notification-service/
  packages/
    contracts/                shared TS types, DTOs, event schemas
    tenancy/                  tenant context + Mongoose tenant plugin
    auth/                     JWT guards, permission decorators
    events/                   outbox, NATS publisher/consumer, idempotency
    service-kit/              NestJS service foundation: config, context, DB, events, errors, logs, health, OpenAPI
    testing/                  test helpers, tenant fixtures
  infra/
    docker/                   Dockerfiles, compose, nginx, mongo init
  docs/
  .github/workflows/
```

## 11. Step 1 acceptance criteria ("done" means all of these pass)

1. `docker compose up` starts the whole stack from a clean machine.
2. A tenant can sign up. That creates the tenant, root org unit, Tenant Admin user and default roles (a saga).
3. The Tenant Admin can log in with 2FA, build an org hierarchy of any depth, create roles and invite users.
4. **Isolation:** Tenant A cannot read or change Tenant B's data through the API, the repository layer, background jobs or events. There are automated tests for each.
5. Every sensitive change creates an audit record, and chain verification catches a tampered record.
6. The country list API returns about 190 countries with currency, locale and timezone.
7. The UI shell works in English plus one RTL language (Arabic), with language switching.
8. Lint, type-check, unit and integration tests pass in GitHub Actions.

## 12. Confirmed decisions

1. **NATS JetStream** is the event bus.
2. **Turborepo + pnpm** run the monorepo.
3. **Node 22 LTS** runs in the containers.
4. Emails go out over **SMTP** (Hostinger email or any provider). Local development uses Mailpit.
5. The GitHub repo is `github.com/mynameiscod/erp-global`.

## 13. Step 1 implementation notes and known limits

These are deliberate Step 1 boundaries, each with a planned next step:

| Area | Behaviour today | Planned |
|---|---|---|
| MongoDB has no row-level security | Isolation comes from the tenant plugin (fails closed), tokens verified at the gateway and in each service, one DB user per service, and dedicated databases for clients who need them. A service's DB user can still read every tenant in that service's shared database. | Field-level encryption for sensitive data; dedicated clusters for regulated clients. |
| Audit chain | Detects any edited, deleted or inserted record, and a truncated tail. Someone with database write access could rewrite *all* records from the tampered point onward. | Periodically publish signed chain checkpoints outside the database. |
| Logout and role changes | A refresh token is revoked at once. An access token stays valid until it expires (15 min max), so role or org changes reach it on the next refresh. | Session deny-list in Redis, checked by the gateway. |
| Mandatory 2FA | When the company requires it, login returns `mfaSetupRequired` and the UI sends the user to set it up. | Server-side block on everything except 2FA setup until the user enrolls. |
| Data placement | Shared or dedicated is chosen when the tenant is created. | Online migration between shared and dedicated. |
| Email copy | Templates in English, Hindi and Arabic are in code. | Move to Language Packs so tenants can edit them. |
| Login methods | Email + password + TOTP. | Mobile OTP (SMS/WhatsApp), Google/Microsoft SSO and SAML/OIDC in Step 2. |
