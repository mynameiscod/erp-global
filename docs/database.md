# D. Database Strategy

## 1. Principles

1. **PostgreSQL (16+) is the system of record.** No document store is authoritative for business data.
2. **One Postgres schema per bounded context** (`finance`, `inventory`, `metadata`, `records`, …).
   Encoding is UTF-8. User-visible sorting and comparison use ICU collations, and inbound text is
   NFC-normalized.
   Only the owning module's repositories may touch a schema; this is enforced by per-module DB roles
   in integration tests and by ArchUnit rules on package access.
3. **Every table declares its tenancy scope** ([multitenancy.md §4a](multitenancy.md#4a-tenancy-scope-of-every-table)).
   Tenant-scoped tables have `tenant_id uuid not null`, forced RLS, and `tenant_id` as the leading
   column of their primary key or of every lookup index. Organizational columns follow the
   aggregate's ownership scope ([domain-model.md §5](domain-model.md#5-ownership-and-scope-model)).
4. **IDs:** UUIDv7 (time-ordered, index-friendly, globally unique across cells — required for
   tenant relocation and cross-region merges). Human-facing numbers (INV-2026-000123) come from
   `documents.number_sequence`, never from IDs.
5. **Money:** `numeric(24,6)` amount + `char(3)` ISO 4217 currency on every monetary column pair;
   rates `numeric(28,12)`. Rounding is explicit per currency minor units and per country-pack
   rounding rules — never floating point, never implicit.
6. **Time:** `timestamptz` (UTC) for instants; `date` for business dates (posting date, due date)
   interpreted in the legal entity's timezone; `tstzrange` for validity periods.
7. **Optimistic concurrency:** `version bigint` on every mutable aggregate root.
8. **Migrations:** Flyway, one migration folder per module, applied in module-dependency order.
   Expand → migrate → contract for zero-downtime changes; no destructive change ships in the same
   release as the code that stops using the column. Tenant-scoped *data* migrations (e.g. pack
   upgrades) run as idempotent, resumable jobs recording progress per tenant.

## 2. Relational core (hardened engines)

Hardened contexts (finance, tax, payments, billing, inventory, party, identity, authorization, audit,
organization, tenancy) use conventional normalized tables with FK, CHECK, UNIQUE and EXCLUDE constraints.
Examples of invariants enforced in the database, not just in Java:

| Invariant | Mechanism |
|---|---|
| Journal entry balances (Σ debit = Σ credit in functional currency) | Deferred constraint trigger on `journal_line` checked at commit |
| Posted entries are immutable | ledger tables are insert-only (grants + trigger); drafts live in separate tables (see the ledger section below) |
| Stock history is immutable | `stock_move` is insert-only (grants + trigger) |
| No posting into closed periods | FK to `period` + check trigger on period status |
| Tax rates don't overlap for the same code/jurisdiction | `EXCLUDE USING gist (tenant_id WITH =, tax_code_id WITH =, validity WITH &&)` |
| Stock can't go negative (where configured) | Checked in the `stock_quant` projection update inside the same tx, with row lock |
| Payment webhooks processed once | `UNIQUE (provider, provider_event_id)` on `payments.webhook_inbox` |
| Idempotent API calls | `UNIQUE (tenant_id, idempotency_key)` on `platform.idempotency_record` |

### Ledger (finance), ADR-0011

```
ledger(id, tenant_id, legal_entity_id, code, purpose[PRIMARY|STATUTORY|MANAGEMENT|CONSOLIDATION],
       accounting_standard, functional_currency, reporting_currency, coa_id)          -- "books"
journal_entry(id, tenant_id, legal_entity_id, ledger_id, journal_id, entry_number,     -- gapless per sequence scope
              entry_type[STANDARD|REVERSAL|ADJUSTMENT|REVALUATION|CLOSING|OPENING|CONSOLIDATION],
              document_date, posting_date, value_date, period_id,
              txn_currency, source_module, source_document_type, source_document_id, source_document_version,
              reversal_of_id,                                   -- set only on the reversing entry
              intercompany_ref, idempotency_key, posting_rule_version_id,
              posted_at, posted_by, correlation_id, created_at)  -- INSERT-only; no status column, no version
journal_line(id, tenant_id, entry_id, line_no, account_id,
             debit_txn, credit_txn, txn_currency, fx_rate, fx_rate_id,
             debit_func, credit_func, func_currency,
             debit_rpt,  credit_rpt,  rpt_currency,
             party_id, open_item_ref, tax_code_id, tax_rate_version_id,
             branch_id, cost_center_id, profit_center_id, project_id,   -- promoted dimensions
             dimensions jsonb, description_key, description_text)
journal_entry_draft / journal_line_draft                        -- mutable drafts live in separate tables
account_period_balance(tenant_id, ledger_id, account_id, period_id, dimension_hash, ...)  -- projection, same tx
```

Invariants and how they are enforced:

| Requirement | Mechanism |
|---|---|
| Posted entries cannot be edited | `journal_entry` / `journal_line` are **insert-only**: the app role has only `INSERT, SELECT` grants, and a trigger rejects `UPDATE`/`DELETE` for every role except the migration owner. A posted row has no mutable status. Drafts live in separate `*_draft` tables and are copied into the ledger on post. |
| Corrections | a new entry with `entry_type = REVERSAL` and `reversal_of_id`, or an `ADJUSTMENT` entry. "Is reversed" is **derived** (a reversal exists), never written back onto the original. A unique index on `reversal_of_id` prevents double reversal. |
| Every journal balances | deferred constraint trigger at commit: Σdebit = Σcredit **per entry** in functional currency, and also in transaction currency when the entry is single-currency. Intercompany is one entry per legal entity, each balanced, linked by `intercompany_ref`. |
| Idempotency | `UNIQUE (tenant_id, idempotency_key)`; the key is derived from the source (`billing.invoice:{id}:v{n}:post`). A retry returns the existing entry. |
| Transaction boundaries | `PostingService.post()` joins the **caller's** transaction (`MANDATORY` propagation; it fails if there is none). The document state change, ledger entry, balance projection, outbox event and audit row commit or roll back together. |
| Currency is explicit | every amount column has a sibling currency column; `func_currency` must equal the ledger's functional currency (check trigger); an FX rate id is required when txn ≠ func. |
| Posting vs effective dates | `document_date` (on the source document), `posting_date` (decides period and fiscal year), `value_date` (bank/interest effect). The period is derived from `posting_date` and must be OPEN for the ledger. |
| Source references | `source_module/type/id/version` are required, except for manual journals (`source_module = 'finance.manual'`), which require an approval workflow. |
| Numbering | `entry_number` and statutory document numbers are **gapless** per configured sequence scope (legal entity + journal + fiscal year). They come from a row-locked counter allocated in the posting transaction, not from a Postgres `SEQUENCE` (sequences leave gaps). India's GST invoice-serial rules and most other jurisdictions need this. |
| No bypass of accounting controls | only `finance.internal` holds repositories for ledger tables (ArchUnit); the per-module DB-role integration test proves no other module's role can insert into `finance`; `PostingService` validates open period, account postability, account/party/dimension rules and posting-rule versions. Workflows, automations and AI reach posting only through actions that call `PostingService`. |
| Audit | every posting writes an `audit_event` in the same transaction; the immutable ledger rows are themselves evidence. |

**Designed to grow into:**
- **AR/AP:** subledgers are lines with `party_id` + `open_item_ref`; allocation records settle open items.
- **Cash:** bank accounts and statements are reconciled against lines.
- **Assets:** the asset register posts depreciation through `PostingService`.
- **Tax:** tax lines carry `tax_code_id` + `tax_rate_version_id`, and returns read the lines.
- **Multi-currency:** three amount triples plus revaluation entries.
- **Consolidation:** `ledger.purpose = CONSOLIDATION` at group level, with elimination entries and translation at configured rate types.

None of these needs a new foundation, only new modules posting through the same service.

`dimensions jsonb` holds tenant-defined analytic dimensions as `{dimensionCode: valueId}`. The
common dimensions (branch, cost center, profit center, project) are promoted to real columns.

### Inventory: an immutable movement ledger

Inventory follows the same philosophy as the ledger. **On-hand quantity is never stored as a fact.
It is the sum of immutable movements.**

```
stock_move(id, tenant_id, legal_entity_id, move_type, item_id, lot_id, serial_id,
           from_location_id, to_location_id,            -- virtual locations: SUPPLIER, CUSTOMER, PRODUCTION,
                                                        --   SCRAP, INVENTORY_LOSS, TRANSIT
           quantity, uom_id, base_quantity,             -- always positive; direction = from -> to
           unit_cost, cost_currency, valuation_layer_id,
           movement_date, posting_date,
           source_module, source_document_type, source_document_id, source_line_id,
           reversal_of_id, idempotency_key, correlation_id, created_at, created_by)   -- INSERT-only
stock_quant(tenant_id, item_id, location_id, lot_id, serial_id, quantity, reserved_quantity, version)
                                                        -- projection, updated in the same tx; re-derivable
valuation_layer(...)                                    -- FIFO / moving-average cost layers
```

- **Move types** are extensible; each maps to a from/to virtual-location pattern: `PURCHASE_RECEIPT`,
  `PURCHASE_RETURN`, `SALE_ISSUE`, `SALE_RETURN`, `CONSUMPTION`, `PRODUCTION_OUTPUT`,
  `DAMAGE`/`SCRAP`, `ADJUSTMENT_GAIN`, `ADJUSTMENT_LOSS`, `TRANSFER_OUT` → `TRANSIT` → `TRANSFER_IN`,
  `OPENING_BALANCE`.
- A transfer between branches is two moves through a `TRANSIT` location, so goods in transit are visible.
- Corrections are reversal moves; physical counts produce adjustment moves for the difference.
  Historical moves are never updated or deleted (same insert-only grants and trigger as the ledger).
- `stock_quant` is a cache: a verification job re-derives it from moves and alerts on drift. Where a
  negative-stock rule is configured, it is checked with a row lock on the quant inside the move's transaction.
- Moves with financial effect post valuation entries through `PostingService` in the same transaction.
- Built in Phase 6. The principle and table shape are fixed now, so nothing earlier assumes a
  mutable quantity column.

## 3. Metadata-defined records

### Which model does a concept use?

| Use the **hardened relational** model when... | Use **metadata-defined** entities when... |
|---|---|
| it carries financial, stock, tax, payment, identity, security or audit invariants | it is industry- or tenant-specific master or transactional data without platform-level invariants |
| other kernel modules depend on its fields at compile time | only configuration (forms, views, workflows, reports) depends on it |
| it has very high write volume across all tenants (POS lines, stock moves) | its volume is moderate, or it can move to `DEDICATED_TABLE` later |

- **Hardened:** tenants, users, roles, org units, legal entities, parties, ledger, invoices, bills,
  payments, tax, inventory items and movements, subscriptions, audit.
- **Metadata-defined:** students, courses, patient encounters (each pack's clinical data model),
  vehicles and any tenant's custom objects.
- Metadata **customizes both kinds**: custom fields, relationships, forms, views, workflows,
  reports and dashboards.
- There is **no** universal table holding all ERP data, and **no** hand-written SQL table for every
  future industry object.

If a metadata entity later needs platform invariants, an ADR promotes it into a hardened module
and a data migration moves it out of `records.record`. The API contract
(`/api/v1/records/{entity}`) does not change, because hardened entities are also exposed as system entities.

### Storage

This is the part that must be flexible *and* fast. Chosen model (ADR-0005): **typed record store
with promoted index columns**, not one giant JSON table, not runtime DDL per tenant entity.

```
metadata.entity_def(id, tenant_id NULL=system/pack, api_name, pack_id, storage_mode, …, revision)
metadata.field_def(id, entity_def_id, api_name, type, required, unique, indexed, classification,
                   translatable, formula_cel, validation_cel, default_cel, index_slot, …)

records.record(                          -- hash-partitioned by tenant_id (e.g. 64 partitions)
    tenant_id, id, entity_def_id,
    legal_entity_id, org_unit_id, owner_user_id,     -- nullable; required per the entity's ownership scope
    status, name,                                    -- universal system fields
    data jsonb,                                      -- field values, validated against compiled metadata
    i_text_1..i_text_8, i_num_1..i_num_4, i_date_1..i_date_4, i_ref_1..i_ref_4,   -- promoted index slots
    search_vector tsvector,
    created_at, created_by, updated_at, updated_by, version, deleted_at)
records.record_link(tenant_id, relationship_def_id, from_id, to_id, ord)       -- many-to-many
records.record_translation(tenant_id, record_id, field_id, locale, value)      -- translatable fields
```

- Fields marked `indexed`/`unique` are assigned an **index slot** at publish time; the record
  service writes the value into `data` *and* the slot. Partial indexes are
  `(tenant_id, entity_def_id, i_text_1)`, so every entity gets indexed filter/sort on up to N fields
  without DDL. Unique fields use a unique index on `(tenant_id, entity_def_id, slot)` filtered by
  `deleted_at IS NULL`.
- Many-to-one references live in `data` + a ref slot (with an application-enforced referential
  rule, and a `record_ref` FK table where `restrict/cascade` semantics are required).
- **Escape hatch:** an entity can be switched to `storage_mode = DEDICATED_TABLE`. A migration job
  generates a real table in the shared `ext` schema: `ext.<pack>_<entity>` for pack entities (one
  table shared by every tenant that installs the pack) and `ext.t_<definitionId>` for tenant-defined
  ones. The table keeps `tenant_id`, forced RLS and the standard system columns, so isolation is
  unchanged. There is **no schema-per-tenant**. The API stays the same. This is a Phase 12
  optimization: designed for, but not built in, the MVP.
- **Queries** are never hand-built SQL strings from user input: views/reports compile to a typed
  query AST → validated against metadata and the caller's permissions → rendered to parameterized
  SQL with only whitelisted slot columns / JSON paths.

### Custom fields on hardened entities

Hardened tables (e.g. `billing.invoice`, `inventory.item`) carry `custom jsonb not null default '{}'`
plus a small number of promoted slots where needed. Custom field definitions are ordinary
`field_def` rows on the corresponding **system entity** (`entity_def.system = true`). The owning
module validates custom values through the metadata API; it never lets metadata change core columns.

### Where JSONB is and is not used

| ✅ JSONB | ❌ Not JSONB |
|---|---|
| Custom field values; metadata-entity record payloads | Amounts, currencies, quantities, dates of hardened documents |
| Manifest bodies (form layouts, workflow graphs, report defs) | Foreign keys the database must enforce |
| Dimension maps on journal lines (with promoted columns) | Tenant id, org scope, status used by security |
| Provider raw payloads (webhooks, e-invoice responses) — for audit | Anything used in a financial invariant |
| Event payloads in the outbox | |

## 4. Metadata compilation and performance

Published config revisions are **compiled** into an immutable, per-tenant runtime model (entity
schemas, validators, CEL programs pre-parsed, permission masks, slot maps) cached in-process
(Caffeine) keyed by `(tenant_id, revision)` with Redis pub/sub invalidation. Request handling
never interprets raw manifests. Target budgets (checked by load tests in Phase 12, tracked from
Phase 2): record read p95 < 30 ms, list view (50 rows, 2 filters on indexed fields) p95 < 150 ms
at 10M records per tenant partition.

## 5. Tenant isolation in the database

See [multitenancy.md](multitenancy.md). Summary: RLS on every tenant table using
`current_setting('app.tenant_id')`, set with `SET LOCAL` at transaction start by the persistence
layer; application connects as a role **without** `BYPASSRLS` that does not own the tables.

## 6. Outbox, inbox and audit tables

- `platform.outbox(id uuidv7, tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type,
  event_version, schema_ref, payload jsonb, correlation_id, causation_id, trace_parent, occurred_at,
  published_at, attempts, last_error)`. Envelope contract: [ADR-0008](adr/0008-events-and-outbox.md).
  Scope `DISPATCH`.
- `platform.inbox(consumer, event_id, tenant_id, processed_at)`: consumer-side dedupe,
  `PRIMARY KEY (consumer, event_id)`.
- `platform.dead_letter(...)`: events or jobs that exhausted retries, with replay tooling.
- `audit.audit_event(...)`: append-only. A sealing job hash-chains it per tenant and chain
  partition. See [ADR-0016](adr/0016-tamper-evident-audit.md).

## 7. Analytics separation

Operational queries run on Postgres (and read replicas for heavy list/report queries). From
Phase 12, outbox events and CDC feed ClickHouse for analytics, process mining and anomaly
detection. **No transaction path reads from the analytics store.**

## 8. Seed data

`db/seed/{dev,demo,test}` datasets loaded only by explicit profile flags; production images
contain no demo data. Packs provide *reference* data (tax codes, CoA templates, currencies), which
is not demo data and is installed through the pack pipeline.
