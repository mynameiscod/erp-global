# global-erp (codename): Architecture Documentation

Phase 0 deliverable (Master Engineering Prompt §110). No implementation code exists yet; these
documents are the baseline that Phase 1 implements against. Changes to anything here that is
already captured in an ADR must go through a new ADR that supersedes it.

| § | Deliverable | Document |
|---|---|---|
| A | Repository assessment | [00-repository-assessment.md](00-repository-assessment.md) |
| B | Product architecture (context, container, module, deployment, multi-region) | [architecture.md](architecture.md) |
| C | Domain boundaries / bounded contexts | [domain-model.md](domain-model.md) |
| D | Database strategy | [database.md](database.md) |
| E | Multi-tenant strategy | [multitenancy.md](multitenancy.md) |
| F | Extension architecture (country / industry / language packs, payment adapters, connectors) | [extensions.md](extensions.md) |
| G | Security model | [security.md](security.md) |
| H | Globalization strategy | [localization.md](localization.md) |
| I | AI architecture | [ai-architecture.md](ai-architecture.md) |
| J | Implementation roadmap | [roadmap.md](roadmap.md) |
| K | Module dependencies and integration contracts | [module-dependencies.md](module-dependencies.md) |
| — | Phase 0 architecture gate review (2026-09-24) | [review/phase0-architecture-gate.md](review/phase0-architecture-gate.md) |
| — | Architecture Decision Records | [adr/](adr/) |

## Architecture in one paragraph

A **modular monolith** (Java 21 LTS/Spring Boot, Spring Modulith-enforced boundaries) is deployed
per **regional cell** (first cell: Hostinger VPS, India), backed by **PostgreSQL** with **row-level security** as the tenant
isolation backstop. A separate, small **global control plane** owns tenants, plans,
entitlements, region placement and the pack/extension registry. Hardened engines (ledger,
payments, inventory movements, identity, authorization, audit, tax) are **relational and
strongly typed**. Everything industry-specific is **declarative metadata** — entities, fields,
forms, views, workflows, rules, reports, dashboards — expressed in one **config-as-code manifest
format** that the Studio UI, the CLI/Git and the AI builder all produce. Country behaviour is
delivered through **Country Packs** (effective-dated data + first-party SPI implementations),
industry behaviour through **Industry Packs** (pure metadata + optional sandboxed extensions),
and every external provider (payments, e-invoicing, messaging, storage, secrets, AI models) through
**adapter ports**. India is the first market, served entirely by the India Country Pack. The kernel never contains `if country == …` or `if industry == …`.

## Document conventions

- Diagrams are Mermaid so they render on GitHub and stay diffable.
- "MUST / MUST NOT" are hard constraints that code review and architecture tests enforce.
- Every open question is listed in the document where it arises under **Open questions**, and
  in the consolidated list in [roadmap.md](roadmap.md#open-questions-requiring-product-decisions).
