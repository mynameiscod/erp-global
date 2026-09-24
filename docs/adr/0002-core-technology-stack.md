# ADR-0002: Core technology stack

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Decision
| Concern | Choice |
|---|---|
| Backend language/runtime | **Java 21 LTS** is the production and CI target. Built with Gradle toolchains (Foojay resolver), so the local JDK (17 on the current dev machine) never lowers the target. A move to the next LTS is a separate ADR. |
| Framework | Spring Boot (latest GA at scaffold time), Spring Security, Spring Modulith, Spring JDBC / Spring Data JDBC (JPA only where an aggregate clearly benefits); jOOQ or plain JDBC for the query compiler and the ledger |
| DB | PostgreSQL 16+ (pgvector for AI retrieval) |
| Migrations | Flyway |
| Cache | Redis 7+ (L2), Caffeine (L1) |
| Jobs | db-scheduler (Postgres-backed, cluster-safe) behind a `JobScheduler` port |
| Resilience | Resilience4j |
| Expressions | cel-java (see ADR-0007) |
| i18n server | ICU4J |
| PDF | HTML → PDF with openhtmltopdf (bidi/shaping), or a headless-Chromium render worker if complex-script shaping falls short (spike in Phase 8) |
| Observability | OpenTelemetry Java agent/SDK, Micrometer → Prometheus |
| Testing | JUnit 5, AssertJ, Testcontainers, ArchUnit, jqwik (property tests), k6 (load) |
| Node/TS | Node 22 LTS for frontend tooling and the realtime gateway only |
| Frontend | see ADR-0013 |
| Mobile | Flutter (see ADR-0013) |
| Infrastructure | see ADR-0014 (Hostinger first, cloud-portable) |

Exact versions are pinned in Phase 1 (Gradle version catalog, `package.json`, Docker image tags)
after checking current GA releases. This ADR fixes the choices, not the patch versions.

## Consequences
Strong typing and a mature ecosystem for financial correctness. Builds are reproducible from a
clean checkout with only a JDK 17+ launcher, Docker and Node installed (see ADR-0003).

## Alternatives
Kotlin (viable; rejected only to keep one JVM language and a wider hiring pool). Node.js for the
core (rejected by the spec for ledger integrity). .NET (no existing investment).
