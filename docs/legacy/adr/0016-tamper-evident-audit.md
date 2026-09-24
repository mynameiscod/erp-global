# ADR-0016: Tamper-evident audit log

**Status:** Accepted · **Date:** 2026-09-24

## Context
Audit must be written atomically with business and security mutations, be tenant-isolated, and be
tamper-evident. Chaining each row to the previous one *inside* every business transaction would
serialize all writes of a tenant on one chain-head row lock, a throughput bottleneck and deadlock
source. Audit is also not application logging.

## Decision

### What is audited (and what is not)
- **Audit events** record security- and business-relevant mutations and decisions:
  - create/update/delete of business and configuration data;
  - posting, approval and payment actions;
  - authentication events relayed from the IdP, role and permission changes, authorization
    denials on sensitive resources;
  - exports, break-glass access, AI proposals and executions, pack lifecycle operations.
- **Application logs** (debug/info/errors, request logs) go to the log pipeline (Loki). They are
  not audit, are not tamper-evident and have their own retention.

### Write path
`audit_event` rows are inserted **in the same transaction** as the change. The row holds `id`
(UUIDv7), `tenant_id`, `chain_partition`, `occurred_at`, actor (type, id, on-behalf-of), legal
entity, action, object type and id, before/after diff, correlation id, causation id, request
metadata (IP, user agent, session, API client), reason and source. Chain columns (`seq`,
`prev_hash`, `hash`, `sealed_at`) start `NULL`. The app role may only `INSERT` and `SELECT`, and a
trigger forbids every update except the sealer filling in the chain columns once.

### Sealing (hash chain)
- A **sealer** job (worker, `erp_dispatcher` role) processes committed, unsealed rows per
  `(tenant_id, chain_partition)` in `(occurred_at, id)` order and assigns a gapless `seq`:
  `hash = SHA-256(prev_hash || canonical_json(event))`.
- Canonical JSON uses RFC 8785 (JCS) over every audited field except the chain columns.
- **Partitioning:** one chain per tenant by default. Large tenants use N partitions (by legal entity
  or hash), each chain independent. Chains never cross tenants.
- Target sealing lag: under 5 seconds p95. Events are fully durable before sealing; sealing only
  adds tamper evidence.

### Anchoring and verification
- Every hour (and at each period close), the head hash of each chain is written to an **anchor
  log**: in the control plane, and as an object in S3-compatible storage with **object lock
  (WORM)**. Anchors are signed with a key held in OpenBao transit.
- `GET /api/v1/audit/verify?from=&to=` (and a scheduled job) recomputes the chain and compares it
  with the anchors. A mismatch raises a critical security incident.
- **Cryptographic assumptions:** SHA-256 collision resistance and signing-key secrecy. The chain
  proves an **unanticipated** modification. A DB superuser could rewrite unanchored recent history,
  so anchoring frequency bounds that window.

### Sensitive values
Before/after diffs mask fields by classification (`PII`, `HEALTH`, `RESTRICTED`, secrets). Instead
of the value they store a keyed hash (HMAC with a per-tenant key), which proves *that* a value
changed without revealing it. Secrets are never recorded.

### Retention, archival, export
- `audit_event` is range-partitioned by month.
- Partitions past the online retention window are exported with their chain segments and anchors
  (Parquet + manifest), verified, written to WORM object storage, and only then detached.
- Legal holds block detachment.
- Tenants can export their audit trail with verification material (portability and auditors).

### Performance
One indexed insert per audited mutation inside the business transaction, with no chain-head lock.
Sealing is batched per chain.

## Consequences
+ No write serialization; tamper evidence within seconds; independently verifiable exports.
− A short window where fresh rows are unsealed (they are still durable and access-controlled).

## Alternatives
Synchronous per-row chaining (rejected: lock contention). An external ledger database (deferred;
anchoring gives most of the value).
