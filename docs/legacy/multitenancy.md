# E. Multi-Tenant Strategy

## 1. Hierarchy

```
Platform
└─ Partner (optional reseller)           control plane
   └─ Tenant                             control plane + cell  ← isolation boundary
      └─ Org unit tree                   cell (organization module)
         Group → Legal entity → Business unit → Division → Branch → Department → Cost center …
```

**The tenant is the security and data-isolation boundary.** Legal entities, branches etc. are
*authorization scopes inside* a tenant, not isolation boundaries. A holding company with 40
subsidiaries is one tenant with 40 legal entities (so consolidation and intercompany work);
two unrelated companies are two tenants even if a partner manages both.

## 2. Deployment modes

| Mode | Compute | Database | Cache | Storage | Keys | Use |
|---|---|---|---|---|---|---|
| **Shared** | shared cell pods | shared Postgres cluster, shared schemas, RLS | shared Redis, tenant-prefixed keys | shared bucket, `/{tenantId}/` prefix | per-tenant data key (envelope-encrypted) | SMB default |
| **Dedicated DB** | shared cell pods | dedicated Postgres cluster (same schemas) | shared Redis | dedicated bucket optional | per-tenant key (`KeyManagement` port) | regulated mid-market |
| **Dedicated environment** | dedicated cell | dedicated | dedicated | dedicated | customer-managed key (future) | enterprise / private cloud |

The **code path is identical** in all three modes. The only difference is what the tenant
directory returns for `tenant → (cell, datasource, cache namespace, bucket, key ref)`.

## 3. Tenant resolution

1. Edge resolves `Host` (subdomain or verified custom domain) → tenant id → cell, from the
   replicated tenant directory. API keys and OAuth client credentials also carry the tenant.
2. `erp-app` validates the JWT; the token's `tenant_id` claim **must equal** the host-resolved
   tenant, else 403 + security audit event. There is no tenant id in URL paths or request bodies
   that the server trusts.
3. A `TenantContext` (immutable) is bound for the request/job/event; code cannot set it from
   user input. Async work (outbox events, jobs, workflow activities) carries `tenant_id` in its
   envelope and re-establishes the context before running.

## 4. Enforcement layers (defense in depth)

Application filtering alone is never relied on. Every layer below enforces tenancy independently.

| # | Layer | Mechanism | Failure mode it covers |
|---|---|---|---|
| 1 | Edge / API request context | host → tenant → cell routing; JWT `tenant_id` must equal the host-resolved tenant, otherwise 403 + security audit event; tenant ids in paths or bodies are never trusted | misrouted or forged requests |
| 2 | Service / domain | immutable `TenantContext` required by every repository, action and PDP call; a missing context throws, and there is no "all tenants" mode | forgotten filter |
| 3 | **PostgreSQL RLS (primary backstop)** | `USING` + `WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)` on every tenant table, `ENABLE` + `FORCE`; `SET LOCAL app.tenant_id` at transaction start; app role is not the owner and has no `BYPASSRLS`. **Fails closed:** an unset setting yields `NULL`, which matches no rows and rejects every write. | SQL bug, raw query, ORM misuse, malformed request |
| 4 | Datasource routing | dedicated-DB tenants get a different pool | shared-cluster compromise |
| 5 | Cache | `TenantCacheKey` builder is the only way to build keys (`t:{tenantId}:…`); Caffeine L1 caches are keyed by tenant; no API builds an unprefixed key | cache bleed |
| 6 | Events (outbox / broker) | `tenantid` is mandatory in the envelope; consumers re-establish `TenantContext` from the envelope before running handler code; inbox dedupe key includes the tenant | cross-tenant event handling |
| 7 | Workers / jobs / workflows | every job, timer and workflow instance row carries `tenant_id`; the dispatcher (below) opens each unit of work under that tenant's context with the normal app role | background leakage |
| 8 | Search indexes | tenant id is a mandatory filter added by the query builder, never by the caller; per-tenant index aliases for large tenants | query leakage |
| 9 | Files / object storage | object keys come only from `StorageService` (`{cell}/{tenantId}/{fileId}`); signed URLs are scoped per object with a short TTL; bucket policies deny listing | path traversal, URL guessing |
| 10 | Reports / exports | report queries compile through the query AST with tenant predicate + RLS; exports run as jobs under the requester's context and permissions | aggregate leakage |
| 11 | Analytics (Phase 12) | analytics rows carry `tenant_id`; the analytics query API injects the tenant predicate; no ad-hoc SQL for tenants | warehouse leakage |
| 12 | AI tools and retrieval | tools are actions executed under the caller's `TenantContext` and permissions; embeddings carry `tenant_id` + RLS; provider calls never receive DB access | prompt-driven exfiltration |
| 13 | Crypto | per-tenant data keys for sensitive fields and files | offline data theft |

### Cross-tenant infrastructure readers

The outbox relay, job scheduler, workflow timer poller and audit chainer must **discover** work
across tenants, but must not **process** it across tenants. The rules:

- They connect as a dedicated role `erp_dispatcher`, which has `SELECT`/`UPDATE` only on
  `platform.outbox`, `platform.scheduled_job`, `workflow.timer` and `audit.audit_event` (chain
  columns only), through an RLS policy scoped `TO erp_dispatcher`. It has **no grants on any
  business schema**, and those columns hold no business payload beyond the event itself.
- For each claimed item, the dispatcher runs the handler in a **new transaction under the normal
  app role with `SET LOCAL app.tenant_id` = the item's tenant**. Business code therefore always runs
  tenant-scoped.
- A catalog test asserts `erp_dispatcher` has no privileges outside that allow-list.

### Platform-operator access

Platform operators reach tenant data only through an explicit **break-glass** flow (ticket
reference, time-boxed, audit visible to the tenant) using a separate DB role. RLS is never disabled.

## 4a. Tenancy scope of every table

Every table is classified in its migration with a `COMMENT ON TABLE … IS 'scope=…'`. The catalog
test fails any table that is unclassified.

| Scope | Meaning | Columns | RLS | Examples |
|---|---|---|---|---|
| `GLOBAL` | platform reference data, identical for all tenants, read-only to the app role | no `tenant_id` | none (app role has `SELECT` only) | ISO currencies, countries, CLDR/locale data, platform permission catalog |
| `TENANT` | owned by one tenant | `tenant_id not null` | forced | tenant settings, roles, metadata definitions |
| `TENANT_PACK` | pack-supplied rows installed **per tenant** (copied or overlaid) | `tenant_id not null`, `pack_id`, `pack_version` | forced | installed tax rates, CoA templates |
| `DISPATCH` | cross-tenant work queues | `tenant_id not null` | forced for the app role; allow-listed policy for `erp_dispatcher` | outbox, scheduled jobs, timers |
| `CONTROL_PLANE` | only in the control-plane DB | per table | n/a (no tenant business data) | tenant registry, plans |

Organizational scope inside a tenant (legal entity, branch, owner) is **not** a tenancy scope. It
is an authorization scope, defined per aggregate in
[domain-model.md](domain-model.md#5-ownership-and-scope-model).

## 5. Tenant lifecycle

`REQUESTED → PROVISIONING → ACTIVE ⇄ SUSPENDED → OFFBOARDING → DELETED(tombstone)`

Provisioning is a durable workflow in the control plane: choose region/cell (residency policy +
capacity) → create tenant record in cell → seed system metadata → install selected Country,
Industry and Language packs → create admin user in IdP → apply entitlements → mark active.
Every step idempotent and resumable.

Offboarding: export (data portability), retention/legal-hold check, crypto-shred tenant keys,
purge partitions/buckets, retain the minimal billing/audit records the law requires.

## 6. Sandboxes and environments

A tenant can own linked **sandbox tenants** (Development/UAT). They are full tenants (same
isolation) with a `parent_tenant_id` and `environment` tag. Configuration moves between them as
signed config packages (see [extensions.md](extensions.md#7-configuration-as-code-and-promotion));
optionally with masked data copies.

## 7. Noisy-neighbour controls

Per-tenant rate limits (API, AI tokens, automation runs, report executions) derived from
entitlements; statement timeouts per role; report/export jobs on the worker queue with per-tenant
concurrency caps; large tenants are moved to a less-loaded cell or to dedicated DB.

## 8. Tenant isolation testing (critical severity)

`platform-test` ships a **TenantIsolationSuite** that every module must extend:

- Creates tenants A and B with identical data shapes.
- **API:** for every REST endpoint discovered from the OpenAPI spec, call as A with B's resource ids
  and expect 404 (not 403, so existence is not disclosed).
- **Malformed requests:** token for A on B's host; missing tenant claim; tampered claim; tenant id
  injected in body, query or headers; expect rejection and a security audit event.
- **Repository:** run each repository method under A's context and assert zero B rows; running with
  no context must throw.
- **Direct SQL as the application DB role:** with `app.tenant_id = A`, `SELECT` from every tenant
  table and assert no B rows; `INSERT … tenant_id = B` must raise an RLS violation; with the setting
  unset, reads return zero rows and writes fail.
- **Background execution:** a job, an outbox event and a workflow timer enqueued for B, executed by
  the dispatcher, must see only B's data, and handler code attempting to read A must get nothing.
- **Catalog:** every table is classified (4a); every `TENANT*`/`DISPATCH` table has RLS enabled and
  forced; the app role owns nothing and has no `BYPASSRLS`; `erp_dispatcher` privileges match the
  allow-list.
- **Test DB credentials:** tests connect as the real `erp_app` role, **never** as the Testcontainers
  superuser (superusers bypass RLS and would make these tests pass vacuously). A guard test asserts
  `current_user = 'erp_app'` and `NOT rolbypassrls`.
- Cache, storage, search, reports and AI tools get equivalent tests as they are built.

A failing isolation test blocks merge. No "skip" annotation is allowed on this suite.
