# ADR-0007: CEL as the sandboxed expression layer

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Context
Formulas, validations, conditional visibility, rules, workflow conditions and ABAC policies need
a safe, fast expression language. Non-developers (via UI) and AI must be able to produce it, and it
must run on both server and client. It must **not** become a general scripting engine.

## Decision
Use **Common Expression Language (CEL)** through `cel-java` on the server (in the platform library
`platform-expressions`, so `authorization` can use it without depending on `rules`) and a CEL JS
implementation on the web client. Client evaluation is advisory only; the server is authoritative.

### Sandbox guarantees (tested by property tests in `platform-expressions`)
- **No I/O:** no filesystem, network, process, reflection or class loading. CEL has none of these,
  and the platform registers no function that performs I/O.
- **Bounded execution:** a cost limit per evaluation (the CEL runtime cost tracker), plus limits on
  expression length, AST depth, list/map size and comprehension iterations, and a wall-clock timeout
  as a backstop.
- **Typed:** every expression is type-checked at publish time against a declared environment (the
  entity schema, `subject`, `resource`, `env`). Untyped or dynamic variables are rejected.
- **Deterministic where required:** `now()`/`today()` read an injected clock value fixed for the
  evaluation (for example the document date or the request instant) and `random()` does not exist.
  Formulas, tax and posting-rule conditions are declared `deterministic` and may not use `env`.
- **Tenant-aware context:** the environment is built by the platform from the current
  `TenantContext`. Lookup functions (`lookup()`, bounded child aggregations) read pre-fetched,
  permission-filtered data only, never arbitrary queries.
- **Versioned:** expressions live inside versioned manifests (`ConfigRevision`). Stored results
  (for example a computed tax) record the revision used.
- **Test/preview:** a `/api/v1/expressions/evaluate` preview endpoint (sandbox data), a manifest
  `tests:` block run at publish, and the rule builder shows evaluation traces.

### Four related but distinct engines
| Engine | Question it answers | Uses CEL for | Side effects | Module |
|---|---|---|---|---|
| **Formula engine** | "What is the value of this field?" | computed/default fields, rollups | none (pure) | `metadata` / `records` |
| **Rules engine** | "Is this allowed / valid / which outcome applies?" | validations, decision tables, eligibility, ABAC conditions | none; returns a decision | `rules` (+ `authorization` for policies) |
| **Workflow engine** | "What is the long-running state of this process, and who acts next?" | transition and step conditions | durable state, human tasks, timers (ADR-0009) | `workflow` |
| **Automation engine** | "When X happens, do Y" | trigger filters and action parameters | invokes actions (`ActionProvider`), idempotent | `automation` |

## Consequences
+ Sandboxed by construction; bounded execution; type errors are caught at publish.
+ The rule builder UI maps 1:1 to CEL ASTs, and AI output is verifiable.
− The custom function library must stay identical across server and client (shared conformance tests).

## Alternatives
JavaScript/GraalJS sandbox (rejected: escape and unbounded-execution risk). SpEL (rejected: too
powerful). A bespoke DSL (rejected: cost). Drools (rejected: too heavyweight for the need).
