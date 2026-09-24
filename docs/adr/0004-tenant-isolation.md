# ADR-0004: Tenant isolation: shared schema + PostgreSQL RLS + cell routing

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Context
The platform must support shared SaaS, dedicated DB and dedicated environment with one code path,
and make cross-tenant access practically impossible even when the application has bugs.

## Decision
- Every table declares a tenancy scope (`GLOBAL`, `TENANT`, `TENANT_PACK`, `DISPATCH`,
  `CONTROL_PLANE`; see multitenancy.md §4a). Tenant-scoped tables live in shared schemas with
  `tenant_id uuid not null`.
- **RLS is enabled and forced** on all tenant-scoped tables. Policies use
  `current_setting('app.tenant_id', true)`, which **fails closed** when unset. The persistence layer
  issues `SET LOCAL app.tenant_id` at the start of every transaction.
- DB roles:
  - `erp_owner` runs migrations and owns the tables.
  - `erp_app` has DML only, owns nothing and has no `BYPASSRLS`.
  - `erp_dispatcher` may only claim rows in the `DISPATCH` tables (outbox, jobs, timers, audit sealing).
  Every handler it dispatches runs as `erp_app` under the item's tenant.
- The tenant directory maps each tenant to a cell and datasource. Dedicated tenants route to their
  own pool/DB with the same schema and the same RLS.
- Tenancy is enforced independently at 13 layers (multitenancy.md §4): request context,
  service/domain, RLS, datasource, cache, events, workers, search, files, reports, analytics, AI
  tools and crypto.
- The TenantIsolationSuite (API, malformed requests, repository, direct SQL as `erp_app`,
  background execution, catalog) is mandatory, cannot be skipped, and must run as `erp_app`,
  never as a superuser.

## Consequences
+ A missing `WHERE tenant_id` cannot leak data; a missing tenant context returns nothing.
+ Same code for all deployment modes.
− RLS adds a small planner cost. Mitigated by leading `tenant_id` in indexes.
− The connection pool must not leak session state. `SET LOCAL` (transaction scope) avoids this, and
  reads without a transaction are disallowed in the persistence layer.

## Alternatives
Schema-per-tenant (rejected: migration fan-out and catalog bloat at 10k+ tenants).
Database-per-tenant for everyone (rejected: cost; kept as a premium mode).
