# ADR-0001: Modular monolith per regional cell + global control plane

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Context
The product spans roughly 35 bounded contexts. Starting with one microservice per context would
multiply operational cost, force distributed transactions between documents and the ledger, and
slow a small team. The spec also requires data residency, dedicated-tenant deployments and the
ability to extract services later.

## Decision
- Build the tenant-facing ERP as **one modular monolith** (`erp-app`) with strict module
  boundaries:
  - only `erp.<module>.api` packages are visible to other modules;
  - one DB schema per module, and no cross-schema queries;
  - events for asynchronous coupling, and SPI inversion instead of upward dependencies.
- The allowed dependency matrix is fixed in [module-dependencies.md](../module-dependencies.md).
  Spring Modulith (`verify()`, cycle detection) and ArchUnit enforce it in `check`.
- Run the same artifact with two profiles: **web** and **worker**.
- Deploy it per **cell**: compute + Postgres + Redis + a storage prefix, in each region. Tenants
  are placed into cells; dedicated tenants get dedicated DBs or whole cells.
- Run a separate small **control plane** (`control-plane-app`) globally for the tenant registry,
  plans, entitlements, regions/cells, the package registry and metering.
- The control plane **never holds tenant business data**. Cells never depend on it synchronously
  to serve requests: they pull signed snapshots (tenant directory, entitlements) and cache them.
  The cell-side `tenancy` module is the only component that talks to the control plane.

## Consequences
+ Local ACID transactions between business documents, ledger, outbox and audit.
+ One deploy unit per cell; simple local development.
+ Clear extraction path: a module with its own schema, `api` DTOs and events can move out
  (criteria in module-dependencies.md §4).
− Requires discipline; boundary violations must fail the build.
− A bad release affects every module in a cell. Mitigated with canary cells and feature flags.

## Alternatives
Microservices from day one (rejected: premature). A single global monolith with one DB (rejected:
violates residency and blast-radius goals).
