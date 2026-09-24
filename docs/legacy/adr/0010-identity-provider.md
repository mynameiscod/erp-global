# ADR-0010: Keycloak as identity broker; the ERP owns authorization

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Decision
Keycloak answers **"who are you?"**. The ERP `authorization` module answers **"what may you do,
on which data, under which legal entity and branch, under what conditions?"**.

- **Keycloak** (self-hosted per cell) handles authentication: passwords, MFA,
  WebAuthn/passkeys, OIDC/OAuth2 flows, SAML/OIDC brokering to enterprise IdPs, social login and
  client credentials. Tenants map to Keycloak **Organizations** in one realm per cell (realm name
  `erp`, brand-neutral).
- The ERP `identity` module wraps Keycloak behind an `IdentityProvider` port (user provisioning,
  IdP linking, session revocation). It can be swapped for a managed IdP (Auth0, Entra External ID,
  Cognito) or Spring Authorization Server.
- Keycloak holds **no ERP permissions**. Tokens carry only identity, tenant and session claims
  (`sub`, `tenant_id`, `sid`, `acr`/`amr` for MFA level). Roles, permissions, data scopes, field
  rules and ABAC policies live in the `authorization` module and are evaluated server-side on every
  request. Keycloak realm/client roles are used only for platform-level distinctions
  (`platform-operator`), never for business access.

## Consequences
+ Mature, standards-compliant authentication without building crypto-sensitive code.
+ Authorization data stays residency-local and tenant-configurable, and permission changes apply
  instantly without re-issuing tokens.
− One more stateful service per cell to operate (HA, upgrades).

## Alternatives
Building auth on Spring Authorization Server (deferred; more code to secure). Realm-per-tenant
(rejected: does not scale to many tenants). Encoding ERP permissions as Keycloak roles (rejected:
cannot express scopes and conditions, and bloats tokens). A managed SaaS IdP (possible later via
the port; residency constraints vary).
