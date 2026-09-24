# ADR-0008: Transactional outbox, event envelope, broker later

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Decision

### Write path
```
BEGIN
  business state change
  INSERT platform.outbox (event)          -- same transaction, same connection
  INSERT audit.audit_event
COMMIT
        │
        ▼
Outbox relay (worker profile, role erp_dispatcher, SKIP LOCKED claims)
        │  MVP: in-process subscribers         Phase 12: Kafka-compatible broker (Kafka or Redpanda)
        ▼
Idempotent consumers (platform.inbox dedupe) → handler runs as erp_app under the event's tenant
```
- "State committed but event lost" cannot happen: the event is in the same commit.
- "Event emitted but transaction failed" cannot happen: nothing leaves the database before commit,
  and the relay publishes only committed rows.
- Delivery is at-least-once. A row is marked `published_at` only after the broker acknowledges it,
  so a crash between publish and mark re-publishes, and consumers dedupe.
- Ordering is guaranteed **per aggregate** (broker partition key = `tenantid:aggregateid`). There is
  no global ordering.
- Failed deliveries retry with exponential backoff, then land in `platform.dead_letter` with
  replay tooling. Financial and payment side effects never rely on at-most-once delivery.
- Moving to a broker changes only the relay. Producers and consumers are unaffected.

### Envelope (CloudEvents 1.0 + extensions)
| Attribute | Meaning |
|---|---|
| `id` | event id, UUIDv7, globally unique; the dedupe key |
| `specversion` | `1.0` |
| `type` | `<module>.<aggregate>.<event>.v<major>`, e.g. `billing.invoice.posted.v1` (no brand prefix, ADR-0015) |
| `source` | `urn:erp:cell:<cellId>:module:<module>` |
| `subject` | aggregate id |
| `time` | occurrence instant (UTC) |
| `datacontenttype` | `application/json` |
| `dataschema` | schema URI in the event catalog, e.g. `urn:erp:schema:billing.invoice.posted:1.2` |
| `tenantid` | **required**; consumers refuse events without it |
| `aggregatetype`, `aggregateid`, `aggregateversion` | aggregate identity and version after the change |
| `correlationid` | end-to-end request/business correlation id |
| `causationid` | id of the command or event that caused this event |
| `traceparent` | W3C trace context |
| `actor` | user / service account / agent id (no PII) |
| `data` | payload with no secrets, masked per classification; large content is referenced by id |

Versioning: additive changes bump the schema minor (`1.1 → 1.2`, same `type`). Breaking changes
publish a new `type` suffix (`.v2`), and both are emitted during a deprecation window. Contract
tests verify producers against the catalog.

### Consumers
Every consumer is idempotent via `platform.inbox (consumer, event_id)` inserted in the same
transaction as the consumer's effects. Handlers must tolerate duplicates and out-of-order delivery
across aggregates.

## Consequences
No dual-write inconsistency; auditable event lineage (correlation + causation); a broker is optional
until Phase 12.

## Alternatives
Kafka from day one (rejected for MVP operational cost, especially on self-managed VPS hosting).
Direct in-memory events (rejected: lost on crash).
