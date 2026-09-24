# A. Repository Assessment

**Date:** 2026-09-23 · **Branch:** `main` · **Commits:** none

## Current state

The repository is empty: an initialized Git repository with no commits, no source, no build
files and no CI. This is a greenfield build, so there is:

- **No existing code to reuse or migrate.**
- **No technical debt.**
- **No conflicts with the target architecture.**

## Local toolchain (development machine, Windows 11)

| Tool | Found | Target | Action |
|---|---|---|---|
| Java | 17.0.12 | **21 LTS** | The production/CI target is JDK 21 regardless of the local JDK. Gradle toolchains provision JDK 21 automatically (Foojay resolver); installing Temurin 21 is recommended for IDE use. |
| Gradle | not installed | wrapper | Use the committed Gradle wrapper (`gradlew`); no global install needed. |
| Maven | 3.9.9 | — | Not used (see [ADR-0003](adr/0003-build-tooling-and-monorepo.md)). |
| Node.js | 24.11.0 | 22 LTS+ | OK. |
| pnpm | 9.15.9 | 9+ | OK. |
| Docker | 29.6.1 | 24+ | OK — used for local Postgres, Redis, Keycloak, MinIO, Mailpit. |
| psql | not installed | optional | Not required; use `docker exec` or a GUI client. |

## What should stay / change

Nothing to keep or change. The decisions that shape the first commit are:

1. **Monorepo** containing backend, frontend, packs, SDK, infra and docs ([ADR-0003](adr/0003-build-tooling-and-monorepo.md)).
2. **Modular monolith first**, with a separately deployable control plane ([ADR-0001](adr/0001-modular-monolith-per-regional-cell.md)).
3. **Documentation-first**: this `docs/` tree is the first commit; Phase 1 scaffolding follows only after the architecture is approved.

## Note on the input specification

The Master Engineering Prompt was delivered truncated after §115 ("START NOW — Do not immedia…").
The documents here assume the remainder instructed: *do not immediately start coding; produce the
§110 deliverable first.* If the missing text contained further requirements, they need to be
re-supplied and reconciled against these documents.
