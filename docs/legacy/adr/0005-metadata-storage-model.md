# ADR-0005: Metadata storage: hybrid model with a typed record store

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Context
Tenants and industry packs define their own entities (Student, Patient, Vehicle...). The options are
runtime DDL per entity, EAV, or JSONB documents. The spec forbids "the entire ERP in one giant
JSON table", and also forbids hand-writing SQL tables for every future industry object or
sacrificing performance for flexibility.

## Decision
- **Hybrid model.** The selection rule is in database.md §3:
  - **Hardened domains are strongly typed relational schemas:** tenants, users, org units, legal
    entities, parties, ledger, accounting entries, payments, tax, inventory items and movements,
    subscriptions, audit.
  - Metadata may **extend** hardened domains (custom fields in a validated `custom jsonb` column
    with promoted slots, forms, views, workflows) but never redefine their core model.
- **Metadata-defined entities** (custom objects, industry-pack objects) are stored in
  `records.record`:
  - typed system/scope columns (tenant, entity, nullable legal entity / org unit / owner per the
    entity's ownership scope, status, audit, version);
  - `data jsonb` for field values;
  - a fixed set of **typed index slots** (`i_text_*`, `i_num_*`, `i_date_*`, `i_ref_*`), assigned to
    indexed/unique fields at publish time and backed by partial composite indexes.

  Many-to-many links go in `record_link` and translations in `record_translation`. The table is
  hash-partitioned by tenant.
- Custom relationships, forms, views, workflows, reports and dashboards are manifests
  (ADR-0006) that apply to both kinds of entity.
- All queries go through a query AST compiler that only emits parameterized SQL on known columns.
- An entity may later switch to `DEDICATED_TABLE` storage: a generated table in the shared `ext`
  schema with `tenant_id` + forced RLS, and **no schema-per-tenant**. The API does not change.

## Consequences
+ No runtime DDL in the common case; publishing is instant; RLS applies uniformly.
+ Indexed filtering and sorting for up to N fields per entity.
− Slot limits per entity (mitigated by dedicated-table mode). Cross-entity reporting at scale
  moves to the analytics store.

## Alternatives
Runtime DDL per entity (rejected as the default: migration/locking risk and per-tenant schema drift).
Pure EAV (rejected: query performance). Pure JSONB with GIN only (rejected: weak sort/range
performance, no uniqueness). A universal records table for all ERP data (rejected: no invariants).
