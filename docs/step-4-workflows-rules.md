# Step 4: Workflows, approvals, rules, automations and notifications

> Status: **Implemented.** The owner approved this design on 2026-09-25 ("ok go ahead"), including the four points in section 7. Section 8 lists what differs from the design and the known limits.
> Date: 2026-09-25. Builds on [architecture.md](architecture.md) and [step-2-config-engine.md](step-2-config-engine.md).

## 1. Decisions from the owner

| Topic            | Decision                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Workflow builder | **Form-based builder now**, a visual canvas later on the same engine                          |
| Business rules   | Validate / block save, set / default values, show / hide / require fields, run automations    |
| Approvals        | Multi-level by amount, parallel (all-of / any-of), reminders and escalation (SLA), delegation |
| Notifications    | In-app bell and inbox, email, WhatsApp, web push (PWA)                                        |

## 2. What admins and users will see

**Config Studio, four new tabs:**

1. **Workflows**: pick an entity (e.g. Purchase Request) and define:
   - **States**: Draft → Pending approval → Approved / Rejected / Cancelled, each with a colour and whether the record is locked.
   - **Actions** between states, e.g. Submit, Approve, Reject, Send back, Cancel. For each: who may do it, an optional condition (`amount > 50000`) and whether a comment is required.
   - **Approval steps**: levels picked by condition (amount bands), approvers per level, all-of or any-of, reminders and escalation times.
2. **Rules**: "when [create / update / any save], if [condition], then [block with message / set field / require field / hide field / make read-only]".
3. **Automations**: "when [record created / updated / field changed / status changed / on a schedule], if [condition], do [notify / update record / create record / call webhook / start workflow]".
4. **Message templates**: the text for each notification in each language, with placeholders like `{{record.title}}`, `{{record.amount}}` and `{{actor.name}}`.

All four use the Step 2 draft → publish flow. They are versioned, can be rolled back, and can be overridden per org unit (e.g. a different approval chain for one branch).

**Users:**

- A **bell** with unread count, and a **Notifications** page.
- **My approvals** inbox: everything waiting for me or for people who delegated to me. I can approve or reject with a comment, one by one or several at once.
- On each record: a **status badge**, the action buttons I am allowed to use, and a **timeline** of who did what and when.
- **Account page**:
  - **Out of office**: delegate my approvals to someone from date to date.
  - **Notification preferences** per channel.
  - **Enable push** on this device.

## 3. How it works

### 3.1 Conditions: one language everywhere

Conditions reuse the Step 2 formula language (safe, no code execution) with a few additions:

| Addition                                           | Meaning                                   |
| -------------------------------------------------- | ----------------------------------------- |
| `old.amount`                                       | Value before this save                    |
| `CHANGED(amount)`                                  | True if the field changed in this save    |
| `user.id`, `HAS_ROLE("Finance")`, `IN_UNIT("HYD")` | The acting user, their roles and org unit |
| `STATUS()`                                         | Current workflow state of the record      |

The same evaluator runs in the browser (instant show/hide/require on forms) and on the server. The **server is always the authority**: a rule hidden in the browser is still enforced on save.

### 3.2 Rules (synchronous, inside records-service)

- They run on every save, in a fixed order: defaults → set values → requirements → validations.
- A failed validation refuses the save with the admin's message, translated per language.
- Set-value rules cannot loop: each rule runs once per save.

### 3.3 Workflows and approvals (new `workflow-service`)

- Each record of a workflow-enabled entity has **one workflow instance**, holding its current state and full history.
- An **action** (Submit, Approve…) is checked for:
  - the user's permission
  - the action's condition
  - the record being in the right state

  Then it moves the state and records who, when, the comment, and "on behalf of" if the user acted as a delegate.

- **Approvers** can be:
  - a role at the record's org unit, or its nearest parent that has someone in that role (e.g. "Branch Head", "Regional Head")
  - the requester's **manager** (new "Reports to" field on users)
  - the **head** of an org unit (new field on org units)
  - specific users
  - a user field on the record
- **Levels by condition**: e.g. level 1 always; level 2 if `amount > 50000`; level 3 (Finance) if `amount > 500000`. Levels run one after another. Inside a level: **all of** or **any of** the approvers.
- **Rejection** ends the flow or sends it back to the requester, as configured.
- **Locking**: fields are read-only in locked states (e.g. while pending), except for fields the admin marks as editable.
- **SLA**: "remind after 24 h, escalate after 48 h". On escalation, the task goes to a named role, or skips to the next level. Timers follow business hours only if the company sets them (later: holiday calendars from Country Packs).
- **Delegation**: "from 1 to 10 Oct, my approvals go to Ravi".
  - New and already-waiting tasks show up for both people. Either can act, and the history says who did.
  - You cannot delegate to yourself, and chains of delegations stop after one hop.
- **Self-approval is blocked**: the requester cannot approve their own request, even as a delegate.

### 3.4 Automations (in `workflow-service`)

- **Triggers**:
  - record created, updated or deleted
  - a specific field changed
  - workflow state reached
  - a **schedule**: e.g. "every day at 09:00 in the company's time zone, for records where `due_date` is in 3 days"
- **Actions**:
  - send a notification (template + recipients + channels)
  - update fields on the record
  - create a record of another entity
  - start a workflow
  - call a **webhook**
- **Webhooks**:
  - HTTPS only, signed with HMAC.
  - Retried with backoff. Every call is logged.
  - Blocked from reaching private or internal network addresses.
- **Safety**:
  - Actions run from events, with retries and at-most-once side effects (the Step 1 outbox and idempotent consumer pattern).
  - A chain of automations triggering each other stops after 3 levels.
  - Every run is logged with its result, and an admin can see failures and re-run them.
- **Timers and schedules** live in MongoDB (a small leased job table). There is no new infrastructure on the VPS.

### 3.5 Notifications (extended `notification-service`)

- **Channels**:
  - in-app, stored per user with read/unread
  - email (existing)
  - WhatsApp (Step 3 channel)
  - web push (VAPID, from the PWA's service worker)
- **Templates** are per language and use the user's language, falling back to the company default and then English.
- **WhatsApp**: Meta only allows **pre-approved templates** for business-initiated messages. The admin maps each message to an approved template name and parameter order.
- **User preferences**: a user can turn off a channel per kind of message. Approval requests can't be turned off completely: in-app always stays on.
- **Live updates**: the bell updates within seconds, through a lightweight server-sent events stream at the gateway (falling back to polling).
- **Digest**: optional daily email of pending approvals, instead of one email each.

### 3.6 Where it lives

| Service                    | New responsibility                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| config-service             | Stores workflows, rules, automations and message templates as new config kinds (draft, publish, versions, overrides) |
| records-service            | Runs rules on save, enforces locking, publishes record events with before/after values                               |
| **workflow-service** (new) | Workflow instances, approval tasks, delegation, SLA timers, automations, scheduler, webhook calls                    |
| notification-service       | In-app inbox, web push, per-user preferences, template rendering for all channels, digest                            |
| identity-service           | "Reports to" (manager) on users, delegation settings                                                                 |
| org-service                | Org unit head                                                                                                        |
| web                        | Studio tabs, My approvals, bell and notifications page, record timeline and actions, out of office, push opt-in      |

New permission: `workflow.automation.manage` (see automation runs, re-run failures, see the webhook secret). See section 8 for why the others were not needed.

## 4. Built-in examples (to prove it end to end)

- **Purchase Request**: up to ₹50,000 the branch head approves. Above that, regional head then finance (all-of). Remind after 24 h, escalate after 48 h.
- **Leave Request**: the manager approves (any-of manager or HR). Once approved, the requester gets an email and a WhatsApp message, and a Leave Balance record is updated.
- **Fee Due reminder (schedule)**: every day at 09:00 IST, remind students whose fee is due in 3 days.

The Purchase Request flow is built in the Studio by the automated acceptance test (section 8). Ready-to-install versions of these examples come with the Industry Packs (Step 6).

## 5. Step 4 acceptance criteria

1. An admin builds the Purchase Request workflow in the Studio without code, publishes it, and it works immediately. Rolling back restores the previous chain.
2. Amount bands pick the right levels, and all-of versus any-of behaves correctly. Self-approval is refused. Locked records cannot be edited.
3. Rules block, set, require and hide fields on the server and in the form. A rule bypassed in the browser is still enforced.
4. Reminders and escalation fire on time. The tests control the clock.
5. Delegation lets the delegate act, and the history shows "on behalf of". Delegation ends on its end date.
6. Automations run on create, update, field change, state change and schedule. Webhooks are signed, retried and blocked from internal addresses. Loops stop after 3 levels.
7. Notifications arrive in-app, by email, on WhatsApp and by push, in the user's language, and respect preferences.
8. An org-unit override changes the approval chain for one branch only.
9. Everything is in the audit chain, companies stay isolated, and CI is green.

## 6. Not in Step 4

- The visual workflow canvas (planned right after, on the same engine).
- Business-hours and holiday calendars (these come with Country Packs in Step 6).
- SMS as a channel, and inbound email/WhatsApp replies ("reply APPROVE").

## 7. Owner decisions (confirmed)

1. One new service, **`workflow-service`**, holds workflows, approvals and automations together. Splitting automations into their own service can come later if load needs it.
2. Add **"Reports to"** on users and **"Head"** on org units, so "manager" and "unit head" approvers work.
3. Allow **outgoing webhooks** to external systems (HTTPS, signed, internal addresses blocked).
4. Scheduled automations run **at most every 15 minutes** (daily and hourly are fine). This keeps the VPS light.

## 8. Implementation notes and known limits

### What differs from the design

- **Permissions.** Acting on an approval needs no extra permission: being the assigned approver (or their delegate) is enough, because the workflow already names who approves. Workflow buttons need `records.<entity>.update` on the record, plus the action's roles if set. Timelines follow `records.<entity>.read`. Message templates are configuration (`config.manage`). The only new permission is `workflow.automation.manage`.
- **Escalation without "escalate to".** The level is skipped and the next one starts. On the last level the task stays with its approver, who gets another reminder. The last level is never skipped, because that would approve the request.
- **Webhook addresses.** Must be `https://`. `http://localhost` / `http://127.0.0.1` are accepted for development only; at run time private and internal addresses are refused unless `WEBHOOK_ALLOW_PRIVATE=true` (tests).
- **Built-in examples.** Not shipped as installable templates yet (see section 4).

### How it is built

| Part                                                                                                            | Where                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Formula additions, rule engine, workflow and automation definitions, validation, built-in messages              | `packages/metadata` (`rules.ts`, `automation-types.ts`, `validate-automation.ts`, `builtin-templates.ts`) |
| Rules on save, locking, `status` on records, internal API for the engine                                        | `records-service`                                                                                         |
| Instances, approval tasks, delegation, reminders and escalation, automations, schedules, webhooks, daily digest | `workflow-service` (new, port 3011, database `erp_workflow`)                                              |
| In-app inbox, preferences, web push, live stream, all channels                                                  | `notification-service`                                                                                    |
| Manager ("Reports to") and delegation                                                                           | `identity-service`                                                                                        |
| Unit head                                                                                                       | `org-service`                                                                                             |
| Role holders at a unit                                                                                          | `access-service`                                                                                          |

- **State.** The workflow instance in workflow-service holds the state; the record keeps a copy in `status` for lists, filters and locks. The copy is written right after each change and retried by the scheduler if that call fails.
- **Concurrency.** Two approvers acting at the same moment cannot both complete a level: each change is guarded by the instance version and retried.
- **Timers.** Reminders, escalations, schedules and the digest are jobs in one small collection of workflow-service. The scheduler runs every 15 seconds and leases each job, so several replicas never run the same job twice.
- **Automations.** Each run is recorded once per event, so a redelivered event does nothing twice. Records created by an automation carry a source key, so a retried run cannot create a second record. Automations triggered by automations stop at depth 3.
- **Live updates.** The bell receives server-sent events through the gateway (read with `fetch`, so the access token is sent as a header) and polls every minute as a fallback.

### Configuration

| Service              | Settings                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| workflow-service     | `MONGO_PASSWORD_WORKFLOW` (new database user), `SCHEDULER_INTERVAL_MS` (default 15000)                                                 |
| notification-service | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` for web push (generated by `gen-env`); `APP_URL` for links in emails and push |

### Known limits

| Area                               | Behaviour today                                                                                                                                                       | Planned                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Visual workflow editor             | Form-based builder only                                                                                                                                               | Drag-and-drop canvas on the same engine            |
| Business hours and holidays        | Reminder and escalation times count all hours                                                                                                                         | Working calendars with the Country Packs (Step 6)  |
| Scheduled automations              | Found from the company-level configuration; branch overrides can change or turn off a schedule for their records, not add new schedules. Up to 5,000 records per run. | Per-branch schedules; batching for larger entities |
| Live updates with several replicas | The stream is per notification-service instance; users on another instance see new items on the next poll (up to 1 minute)                                            | Fan-out through NATS                               |
| Webhooks                           | Addresses are checked when resolved; DNS rebinding between the check and the call is not prevented                                                                    | Pin the checked address for the request            |
| Approvers "Specific people"        | Chosen by user id in the Studio                                                                                                                                       | A user picker                                      |
| Rules for automations              | Automations are not blocked by rules or locks (they are the company's own behaviour)                                                                                  | Optional "respect rules" switch                    |
