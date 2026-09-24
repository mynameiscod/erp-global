# ADR-0006: One manifest format for UI, code and AI

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Decision
All configuration is expressed as versioned manifests `{apiVersion, kind, metadata, spec}` in
YAML or JSON, validated by JSON Schemas in `sdk/schemas`. The API group is the brand-neutral
`erp/v1` (see ADR-0015). Kinds include `EntityDefinition`, `Relationship`, `Form`, `View`,
`Page`, `Workflow`, `ApprovalPolicy`, `RuleSet`, `Formula`, `Automation`, `Role`,
`PermissionSet`, `Policy`, `Report`, `Dashboard`, `DocumentTemplate`, `NumberSequence`,
`AgentDefinition` and `Package`.

Studio, `erpctl` (Git) and the AI builder all produce **changesets of manifests**. There is one
pipeline: validate → impact analysis → approve → publish an immutable `ConfigRevision` → compile.
Environment promotion exports and imports signed revisions. Manifests are stored as the source of
truth (`jsonb`), alongside normalized projections (for example `field_def` rows) used for fast lookup.

## Consequences
No drift between GUI and code configuration; diff, rollback and review come for free; packs are
just bundles of manifests. Evolving the manifest schema requires `apiVersion` conversion functions.

## Alternatives
A separate GUI model and code DSL (rejected by spec §85).
