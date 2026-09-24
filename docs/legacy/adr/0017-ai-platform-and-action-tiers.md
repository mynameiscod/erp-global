# ADR-0017: AI platform, provider abstraction and action safety tiers

**Status:** Accepted · **Date:** 2026-09-24

## Decision

### Layering
```
ERP domain modules ──(register actions & queries)──► ActionProvider / QueryProvider registries
                                                           ▲
AI surfaces → ai module (AiPlatform: orchestrator, policy, tools, retrieval, router)
                                                           │
                                                           ▼
                                  AiProvider port → OpenAiProvider (default)
                                                  → AnthropicProvider
                                                  → GeminiProvider
                                                  → AzureOpenAiProvider
                                                  → SelfHostedProvider (future; OpenAI-compatible endpoint)
```
- **Domain modules never call an AI provider or SDK.** An ArchUnit rule forbids provider SDK
  packages outside `backend/adapters/ai-*`. Modules that need AI features call the `ai` module's
  `api`, for example `AiPlatform.extract(...)`.
- **OpenAI** is the initial default provider. Provider and model selection is per-tenant
  configuration handled by the model router (residency, "external AI disabled", data
  classification, cost, health).
- Self-hosted LLM infrastructure is **not** built in the MVP. `SelfHostedProvider` is a later
  adapter and needs no change to business modules.
- AI providers never receive database access or credentials. They receive only prompt content
  that has passed classification filtering.

### Tool execution pipeline
Every AI tool call is an **action** (`ActionProvider`), executed through the same path as a user command:

```
Authentication (user or agent service account)
 → Authorization (PDP: permission + data scope + field mask, intersected with the agent's allowed scope)
 → AI policy (tier, limits, residency, classification, tenant AI settings)
 → Tool (action descriptor, schema-validated input)
 → Domain service (module api; normal validation, ledger rules, workflows)
 → Audit (audit_event + ai.interaction / tool_call records)
```
AI never bypasses domain APIs, workflows, the ledger or audit.

### Action safety tiers
Every action declares a tier in its descriptor. The policy engine enforces it, and tenants may make
it stricter, never looser.

| Tier | Class | Examples | Behaviour |
|---|---|---|---|
| **0** | read / search | search, summarize, explain, run permitted report | execute as the user; results cite records |
| **1** | draft / recommend | draft email, suggest GL account, propose workflow changeset | produces drafts or proposals only; nothing is committed |
| **2** | create non-financial record | create task, lead, note, draft requisition | execute if tenant policy allows; audited; undoable |
| **3** | high-impact business action | submit PO, send invoice to customer, change a customer's credit limit, publish configuration | **proposal → human approval** by a user holding the permission |
| **4** | financial / security / compliance | post journals, approve or send payments, refunds, payroll changes, tax configuration, permission/role changes, data deletion or export | proposal → approval by a permitted user **who is not the requester** (SoD), optional step-up MFA; may be disabled per tenant; never autonomous |

Proposals (`ai.action_proposal`) show the exact action, parameters, affected records and a
deterministic preview. Approvers approve the command, not the prose. Execution is idempotent
(the proposal id is the idempotency key).

## Consequences
Provider changes are configuration, and AI capabilities grow as modules register actions.
The same safety rules apply to workflows and automations that invoke actions.

## Alternatives
Letting modules call provider SDKs directly (rejected: lock-in and inconsistent controls). AI with
a privileged service account (rejected: bypasses user permissions).
