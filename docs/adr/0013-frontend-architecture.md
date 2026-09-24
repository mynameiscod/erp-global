# ADR-0013: Frontend and mobile architecture

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Decision

### Web
- **React + TypeScript (strict) + Vite SPAs.** SSR is not needed for authenticated ERP UIs; Next.js
  only if a public, SEO-relevant portal need arises.
- **TanStack Query** for server state, **TanStack Table + Virtual** for grids, **React Hook Form +
  Zod** for forms (Zod schemas generated from metadata at runtime), and **Zustand** only for local
  UI state that isn't server state.
- **Design system** in `packages/ui`:
  - Radix UI primitives, and Tailwind CSS with design tokens as CSS variables (per-tenant
    white-labelling);
  - **logical properties only**, for RTL;
  - a dir-aware icon component;
  - dnd-kit for builders, React Flow for the workflow designer, and ECharts or Recharts for charts
    (decided in Phase 8).
- **i18n:** FormatJS/react-intl with ICU messages, lazy-loaded namespaces, and no literal UI
  strings (lint-enforced).
- **The metadata runtime is the architecture, not an add-on.** Screens are composed from generic
  primitives rendered from compiled metadata: `EntityList`, `EntityForm`, `EntityDetails`,
  `RelatedList`, `Kanban`, `Calendar`, `Timeline`, `Dashboard`, `Report`, `TaskInbox`,
  `WorkflowDesigner`.
  - There are **no** per-industry page architectures (`StudentsPage`, `PatientsPage`).
  - Industry packs compose primitives through `Page`/`View` manifests.
  - A hardened screen may use a custom component only if it is registered in the component
    library, so Studio can place it.
- Generated API client from OpenAPI; no hand-written fetch calls.
- Testing: Vitest + Testing Library, Playwright E2E (LTR and RTL projects), axe-core, and visual
  regression on the design system.

### Workspace boundaries (`frontend/`, pnpm)
| Path | Purpose | Why separate |
|---|---|---|
| `apps/web` | tenant ERP app: business UI, Studio, tenant administration | one authenticated audience (tenant staff) |
| `apps/portal` | external-user portal: customers, suppliers, students, patients | different audience and trust level; must not ship admin/Studio code; own theme and auth client |
| `apps/ops-console` | platform-operator console for the control plane | different backend (control plane) and identity (operators); never shipped to tenants |
| `packages/ui` | design system and tokens | shared |
| `packages/api-client` | generated OpenAPI clients (cell + control plane) | shared, generated |
| `packages/auth` | OIDC PKCE, token refresh, tenant/host resolution | shared by all apps |
| `packages/i18n` | ICU runtime, locale cascade, formatters, RTL helpers | shared |
| `packages/metadata-runtime` | compiled-metadata client and the entity primitives above | core of `web` and `portal` |
| `packages/workflow-ui` | task inbox, approval UI, workflow designer | used by `web` (and `portal` for tasks) |
| `packages/reporting` | report and dashboard renderers | shared |
| `packages/cel` | client-side CEL (advisory) + conformance tests | shared |
| `packages/shared` | small utilities and types with no UI | shared |
| `packages/config` | eslint, tsconfig, stylelint, tailwind presets | tooling |

Phase 1 creates only `apps/web`, `ui`, `api-client`, `auth`, `i18n`, `shared` and `config`. The rest
are added in the phase that first needs them.

### Mobile
- **Flutter** is the primary mobile and POS strategy (from the phase that needs it, not Phase 1).
- The backend stays client-independent: mobile uses the same public REST API, OIDC flows and
  generated clients (OpenAPI → Dart). Translations are exported from the same ICU catalogs to ARB.
  Client-side rules are advisory; the server is authoritative.
- Code lives in `mobile/` (outside the pnpm workspace), with its own CI job.

## Consequences
One design system across admin, Studio, portals and ops console; RTL and theming are structural
rather than retrofitted. Flutter cannot reuse TS packages, so shared behaviour must live in the
API and in generated artifacts, which keeps the backend client-neutral.

## Alternatives
Angular (rejected: team/ecosystem preference in the spec). MUI (rejected: harder RTL/theming control,
heavier than Radix + tokens). React Native (rejected per product decision 2026-09-24 in favour of Flutter).
