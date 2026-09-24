# Phase 0 Architecture Gate Review

**Date:** 2026-09-24 · **Scope:** all Phase 0 documents and ADR-0001–0013 · **Outcome:** accepted after revisions

The review looked for decisions that would force major rewrites later. It covered gates A–W of
the approval brief and the product decisions locked on 2026-09-24 (India first; Hostinger-first
cloud-portable hosting in Mumbai, which replaces "AWS first"; OpenAI default behind `AiProvider`;
Flutter; proprietary platform with a documented Pack SDK; codename `global-erp`).

## Critical issues found and fixed

| # | Gate | Issue | Rewrite risk | Fix |
|---|---|---|---|---|
| 1 | B | Outbox relay, job scheduler and timers must read across tenants, but only an RLS-bound app role existed. The relay would have needed `BYPASSRLS` or would silently see nothing. | High: touches every async path | `erp_dispatcher` role limited to `DISPATCH` tables; handlers run as `erp_app` under the item's tenant (multitenancy §4, ADR-0004) |
| 2 | B | Integration tests could run as the Testcontainers superuser, which bypasses RLS and makes isolation tests pass vacuously | High: false assurance | Suite must run as `erp_app`, with a guard test (multitenancy §8) |
| 3 | B | RLS policy used `current_setting('app.tenant_id')` without fail-closed semantics | Medium | `current_setting(..., true)`; unset matches nothing; reads outside transactions disallowed |
| 4 | E | The ledger had `status = POSTED → REVERSED` and `reversed_by_id` updates on posted rows, which contradicts insert-only immutability | High: ledger foundation | Insert-only ledger; drafts in separate tables; reversal is derived from `reversal_of_id` (unique) (ADR-0011) |
| 5 | E | No ledger/book dimension: multi-GAAP and consolidation would need a redesign | High | `ledger` (book) entity; `ledger_id` on entries (database §2) |
| 6 | E | No document/value dates, gapless numbering or explicit transaction propagation | Medium–High | `document_date`/`posting_date`/`value_date`; row-locked gapless counters; `PostingService` requires the caller's transaction |
| 7 | Q | Per-tenant hash chain computed inside each business transaction serializes all writes of a tenant on the chain head | High: throughput ceiling | Insert in-transaction, seal asynchronously per chain partition, anchor to WORM (ADR-0016) |
| 8 | A | `packs` depended upward on `tax`/`finance`; `ai` depended on business modules; `workflow`/`automation` called records directly | High: cycles block extraction | SPI inversion (`PackContentHandler`, `ActionProvider`, `QueryProvider`, `SystemEntityProvider`); explicit matrix (module-dependencies.md) |
| 9 | A | CEL runtime lived in `rules` (L3) but `authorization` (L2) needs it for ABAC | Medium | CEL moved to the `platform-expressions` library; PDP interface in `platform-security` |
| 10 | A/C | `Party` was used everywhere but owned by no module | Medium | `party` module (L3) |
| 11 | C | "Every hardened table and record carries legal_entity_id, org_unit_id, owner_id": tenancy and org scope were conflated | High: schema-wide | Ownership scopes per aggregate (PLATFORM/TENANT/LEGAL_ENTITY/ORG_UNIT/USER); cost/profit centers are dimensions (domain-model §5) |
| 12 | D | Dedicated-table escape hatch used a per-tenant `ext_<tenant>` schema, which contradicts the shared-schema + RLS model | Medium | Shared `ext` schema with `tenant_id` + RLS (ADR-0005) |
| 13 | G | Event envelope lacked aggregate id/version, causation id and schema version; no ordering or versioning rules | Medium | Full envelope and versioning rules (ADR-0008) |
| 14 | Hosting | Docs assumed AWS-managed services (KMS, SES, ECS, managed buckets), and the product decision is now Hostinger | High for ops | ADR-0014: self-hosted services behind ports (storage, email, secrets/KMS, AI, payments, broker); cloud SDK ban outside adapters |
| 15 | Naming | Placeholder brand `erp.global` in the manifest `apiVersion` and publisher | Medium: public contract | ADR-0015: neutral `erp` identifiers; configurable branding |

## Other revisions

- **F Inventory:** the immutable movement-ledger principle, move types, transit transfers and
  projection re-derivation are now documented (database §2, ADR-0011).
- **H CEL:** explicit sandbox guarantees, determinism and versioning; the formula, rules, workflow
  and automation engines are distinguished (ADR-0007).
- **I Workflow:** the full concept contract (compensation, callbacks, escalation, failure) is
  documented; workflows are never baked into services (ADR-0009).
- **J/K Packs:** Country Packs apply per legal entity; effective dating uses the transaction tax
  point; India is the first and deepest pack; industry packs depend on capabilities, not countries.
- **L Pack manifest and lifecycle:** required fields; Install, Upgrade, Disable, Enable, Uninstall
  and Rollback semantics; no arbitrary code at install (extensions §1, §1a; ADR-0012).
- **M Extension security:** trusted core vs third-party tiers; a must-not table with enforcement
  mechanisms (extensions §2).
- **N Localization:** language ≠ locale ≠ language pack ≠ country pack; Unicode rules; UI vs
  business-data translation (localization §0).
- **O/P AuthN vs AuthZ:** Keycloak holds no business permissions; grant = action + resource + scope
  + condition (ADR-0010, security §3).
- **R/S AI:** `AiPlatform → AiProvider` with OpenAI as default; the authn → authz → policy → tool →
  domain → audit pipeline; tiers 0–4 (ADR-0017).
- **T/U Frontend:** named metadata primitives; `apps/web`, `apps/portal`, `apps/ops-console`
  boundaries explained; Flutter for mobile (ADR-0013).
- **V JDK:** a fixed Java 21 LTS target via toolchains; deterministic bootstrap (ADR-0002, ADR-0003).
- **W Scope:** Phase 1 scope and acceptance criteria rewritten to the gate's list (roadmap).

## Verified without change

- The modular monolith with a regional-cell and control-plane split (clarified, not changed).
- The hybrid metadata model: hardened relational engines plus a typed record store with index
  slots. This matches the required model: no universal JSON table, and no hard-coded tables per
  industry object.
- The transactional outbox write path, CloudEvents and idempotent consumers.
- Keycloak for authentication only.
- Tax effective dating with rate-version ids stored on transactions, so past transactions never change.

## Result

ADR-0001 to ADR-0013 were revised where needed and accepted. ADR-0014 to ADR-0017 were added and accepted.
