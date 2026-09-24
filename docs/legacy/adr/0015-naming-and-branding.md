# ADR-0015: Neutral internal naming; configurable branding

**Status:** Accepted · **Date:** 2026-09-24

## Context
No commercial product name is approved. Brand names baked into packages, schemas, protocols,
events or extension contracts are expensive to change and break third-party integrations.
Phase 0 drafts used the placeholder `erp.global`.

## Decision
- Internal codename: **`global-erp`**. It appears only in repository-level names, docs and
  deployment labels, never in contracts.
- Contract identifiers use the neutral token **`erp`**:
  | Surface | Convention |
  |---|---|
  | Java packages | `erp.platform.<lib>`, `erp.<module>.api` / `erp.<module>.internal`, `erp.adapters.<name>` |
  | Gradle group | `erp` |
  | npm scope | `@erp/<package>` |
  | Manifest `apiVersion` | `erp/v1` |
  | Event `type` | `<module>.<aggregate>.<event>.v<n>` (no prefix) |
  | URNs | `urn:erp:cell:<id>`, `urn:erp:schema:<name>:<version>` |
  | DB | schema names = module names (`finance`, `organization`); roles `erp_owner`, `erp_app`, `erp_dispatcher` |
  | Keycloak | realm `erp` per cell |
  | HTTP | `/api/v1/...`; headers `X-Correlation-Id`, `Idempotency-Key` (no vendor prefix) |
  | First-party pack publisher id | `official` |
- **Branding is configuration**, resolved per platform and overridable per tenant (white-label):
  product name, logos, colors (design tokens), email sender name, support links and legal footer.
  UI strings reference the product name through an ICU argument (`{productName}`), never a literal.

## Consequences
Renaming the product later changes configuration and translations only.

## Alternatives
Using the codename in packages (rejected: the codename might become the brand or be dropped).
