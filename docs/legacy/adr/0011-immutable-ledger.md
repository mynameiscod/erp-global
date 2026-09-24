# ADR-0011: Immutable double-entry ledger (and immutable stock movements)

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Decision
- All financial effects are journal entries created only through `finance.api.PostingService`,
  which **joins the caller's transaction** (it fails if there is none). The source-document state
  change, entry, balance projection, outbox event and audit row therefore commit atomically.
- Every entry belongs to one **legal entity** and one **ledger (book)**: primary, statutory,
  management or consolidation. Multiple GAAPs and consolidation need no redesign.
- **Posted entries and lines are insert-only.** The app role has no `UPDATE`/`DELETE` grant, a
  trigger rejects both for all but the migration owner, and posted rows have no mutable status.
  Drafts live in separate draft tables.
- **Corrections** are `REVERSAL` entries (`reversal_of_id`, unique, so at most one reversal) or
  `ADJUSTMENT` entries. "Reversed" is derived, never written back onto the original.
- **Every entry balances** in functional currency (and in transaction currency when
  single-currency), checked by a deferred constraint trigger at commit. Intercompany is one balanced
  entry per legal entity, linked.
- **Idempotency:** `UNIQUE (tenant_id, idempotency_key)`, with the key derived from the source
  document and its version.
- **Currency is explicit:** transaction, functional and reporting amounts, each with its currency
  and the FX rate id used. No implicit conversion.
- **Dates:** `document_date`, `posting_date` (decides the period, which must be open) and `value_date`.
- **Source references:** module, document type, id and version are required. Manual journals are
  a distinct source that requires approval.
- **Gapless numbering** per configured scope, from a row-locked counter.
- Period close blocks postings into closed periods, except through a controlled, audited reopen workflow.
- Balances are projections maintained in the same transaction and re-derivable from lines. A
  nightly verification job alerts on drift.
- Posting profiles (which accounts to hit) come from configuration and Country Packs, never hard-coded.
- **No bypass:** only `finance.internal` can write ledger tables (ArchUnit plus a DB-role test).
  Workflows, automations, AI and packs reach the ledger only through actions that call `PostingService`.
- **Inventory follows the same principle:** `stock_move` is an insert-only movement ledger. On-hand
  quantity is a re-derivable projection, and corrections are reversal or adjustment moves
  (database.md, "Inventory").

Full table shapes: database.md §2. The design grows into AR, AP, Cash, Assets, Tax, Multi-currency
and Consolidation without changing this foundation.

## Consequences
Auditability and correctness by construction. "Edit a posted invoice" becomes a credit note plus a
new invoice, which matches accounting practice.

## Alternatives
Mutable entries with an audit log (rejected by spec §24). A status column updated on reversal
(rejected: contradicts insert-only immutability).
