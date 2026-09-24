# ADR-0009: WorkflowRuntime port: DB-backed engine now, Temporal later

**Status:** Accepted · **Date:** 2026-09-23 · **Revised:** 2026-09-24 (architecture gate)

## Decision
Workflows are **definitions (manifests), not Java code in services**. The `workflow` module
executes them through a `WorkflowRuntime` port. Business modules never embed process logic; they
expose **actions** (`ActionProvider`) and emit events that workflows react to.

### Concepts in the contract
| Concept | Meaning |
|---|---|
| Workflow definition | `Workflow` manifest: graph of steps and transitions, inputs, variables |
| Version | definitions are immutable per `ConfigRevision`; instances stay on the version they started with; explicit migration only |
| Workflow instance | one execution: state, variables, business key, `tenant_id`, correlation id |
| Step | node types: human task, automated task (action), approval, condition/decision, parallel split/join, timer, wait-for-event, external callback, sub-workflow, AI task |
| Transition | edge with an optional CEL condition |
| Human task | assignee rules (user, role, org-relative such as "manager of requester"), form, due date, claim/complete/reassign/delegate |
| Automated task | invokes an action with an execution id as the idempotency key |
| Condition | CEL, type-checked at publish |
| Timer | durable, persisted `fire_at`; survives restarts |
| Waiting state | instance parked on an event correlation key or a callback token |
| External callback | signed, single-use callback URL/token resuming a waiting step |
| Retry | per-step policy: max attempts, backoff, retryable error classes |
| Failure | step `FAILED` → instance `FAILED` or `SUSPENDED` for operator repair; incident raised |
| Compensation | steps may declare a compensating action; on failure/cancel, completed compensable steps are compensated in reverse order (saga) |
| Approval | specialized human step: single/sequential/parallel/majority/unanimous, maker ≠ checker, SoD |
| Escalation | SLA timers on tasks: reminder → escalate to next assignee → auto-action |

### Implementations
- **MVP (Phase 4):** a Postgres-backed engine. Instance state and step executions are persisted
  transactionally; timers and retries run via db-scheduler; activities are at-least-once and
  idempotent; recovery resumes from the last committed step.
- **Phase 12:** a Temporal adapter implements the same port for high-volume or long-running
  tenants. Definitions, APIs and activity contracts do not change.

## Consequences
No Temporal cluster is needed for the MVP. The semantics (at-least-once activities plus
idempotency, durable timers, versioned definitions, saga compensation) are chosen to match
Temporal, so migration is mechanical.

## Alternatives
Temporal from day one (deferred, not rejected). A Camunda/BPMN engine (rejected: the BPMN XML
model diverges from our manifest format and pulls in a heavy runtime). Hard-coded workflows in
services (rejected).
