# Architecture Decision Records

Format: [MADR](https://adr.github.io/madr/)-lite: Context, Decision, Consequences, Alternatives.
Status is one of `Proposed`, `Accepted` or `Superseded by ADR-NNNN`. Once accepted, an ADR is
immutable: a decision changes only through a new ADR that supersedes it.

| # | Title | Status |
|---|---|---|
| [0001](0001-modular-monolith-per-regional-cell.md) | Modular monolith per regional cell + global control plane | Accepted |
| [0002](0002-core-technology-stack.md) | Core technology stack (Java 21 LTS) | Accepted |
| [0003](0003-build-tooling-and-monorepo.md) | Monorepo, Gradle and pnpm; deterministic bootstrap | Accepted |
| [0004](0004-tenant-isolation.md) | Tenant isolation: shared schema + PostgreSQL RLS + cell routing | Accepted |
| [0005](0005-metadata-storage-model.md) | Metadata storage: hybrid model with a typed record store | Accepted |
| [0006](0006-configuration-as-code-manifests.md) | One manifest format for UI, code and AI | Accepted |
| [0007](0007-cel-expression-language.md) | CEL as the sandboxed expression layer | Accepted |
| [0008](0008-events-and-outbox.md) | Transactional outbox, event envelope, broker later | Accepted |
| [0009](0009-workflow-runtime-abstraction.md) | WorkflowRuntime port: DB engine now, Temporal later | Accepted |
| [0010](0010-identity-provider.md) | Keycloak as identity broker; the ERP owns authorization | Accepted |
| [0011](0011-immutable-ledger.md) | Immutable double-entry ledger (and stock movements) | Accepted |
| [0012](0012-pack-and-extension-model.md) | Pack and extension model | Accepted |
| [0013](0013-frontend-architecture.md) | Frontend and mobile architecture | Accepted |
| [0014](0014-hosting-cloud-portability.md) | Hostinger-first hosting, cloud-portable architecture | Accepted |
| [0015](0015-naming-and-branding.md) | Neutral internal naming; configurable branding | Accepted |
| [0016](0016-tamper-evident-audit.md) | Tamper-evident audit log | Accepted |
| [0017](0017-ai-platform-and-action-tiers.md) | AI platform, provider abstraction and action safety tiers | Accepted |

All ADRs were accepted on 2026-09-24 after the Phase 0 architecture gate
([review](../review/phase0-architecture-gate.md)).
