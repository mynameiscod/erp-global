# ADR-0012: Pack and extension model

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Decision
- Everything installable is a signed, semver'd **Package**: Country, Industry, Language, Connector,
  PaymentProvider, templates, agents and extensions. Its manifest (extensions.md §1) declares at
  least: `packId`, `type`, `name`, `publisher`, `version`, `minimumPlatformVersion` (+ max),
  `dependencies`, `capabilities` (provided/required), `permissions`, `migrations`, `contents`
  (metadata), `supportedLocales`, `supportedCountries` (where relevant), `license` and
  `integrity` (content hash + signature).
- **Lifecycle** operations are Install, Upgrade, Disable, Enable, Uninstall and Rollback, run by the
  `packs` module as durable, idempotent, audited jobs (extensions.md §1a).
  - Upgrades never rewrite historical rows.
  - Uninstall never deletes business data created by tenants.
- **Installation never executes arbitrary code.** Pack content is manifests and data, applied by
  the owning modules through `PackContentHandler`. Migrations are declarative steps interpreted by
  the platform.
- **Trust tiers** (extensions.md §2):
  1. **Trusted core extensions:** first-party SPI implementations (for example GST determination
     or the Razorpay adapter), reviewed and shipped in the platform release train. They run in the
     JVM but receive data and return results through narrow interfaces. They never get repositories,
     DB connections, the raw `TenantContext` setter or unrestricted secrets.
  2. **Declarative packs:** manifests and data. Anyone may publish them after validation.
  3. **Third-party extensions:** out-of-process only. They receive events and call public APIs with
     scoped, tenant-bound tokens; UI extensions render in sandboxed iframes. WASM may be evaluated later.
- Packs never write to other modules' tables.
- Kernel code may not reference country codes or industry names. An automated source rule over
  `backend/modules` and `backend/platform` enforces this.
- Tenant customizations of pack content are overlays, merged on upgrade with conflicts surfaced.
- **Industry Packs are independent of Country Packs.** They depend on abstract capabilities (tax
  categories, identifier roles, payment-method capabilities), never on a specific country pack.
  `restaurant-india` is never a separate product; the tenant composes
  `industry.restaurant` + `country.in` + `language.te` + `payments.razorpay`.
- Country Packs apply **per legal entity** (by its country), so a tenant with Indian and UAE
  entities installs both packs.
- **Licensing is metadata, not domain logic:**
  - `license` (SPDX id or a commercial license ref), `pricing` (free/paid/private) and `visibility`
    (official/partner/third-party/private-tenant) are package attributes enforced by the marketplace
    and entitlements;
  - domain modules never check licenses.
  - The platform stays proprietary. The pack SDK and manifest spec are documented; publishing them
    as an open spec is a later business decision that this model already permits.

## Consequences
New industries, countries, languages and providers are additive; untrusted code cannot compromise
tenant isolation, permissions, audit or the ledger. First-party SPI code for complex country logic
ships with platform releases (acceptable, since regulatory code needs our review anyway).

## Alternatives
In-process third-party plugins (rejected: security and stability). Purely declarative packs with no
code (rejected: tax, e-invoice and payroll logic needs real code). Per-country industry apps (rejected).
