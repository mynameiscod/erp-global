# Step 2: Config engine (design for review)

> Status: **DRAFT, awaiting owner approval.** No Step 2 code is written until this is approved.
> Date: 2026-09-24. Builds on [architecture.md](architecture.md).

## 1. Goal

A System Admin can shape the ERP for their business **without a developer**:

- add fields to any entity
- create new entities (Student, Vehicle, Hostel Room, Patient…)
- design forms and list views
- define dropdown lists (picklists) and document numbering

Changes are drafted, published as versions, and can be rolled back.
The same engine will carry Country Packs and Industry Packs later.

Decisions already made by the owner:

| Topic       | Decision                                                                              |
| ----------- | ------------------------------------------------------------------------------------- |
| Scope       | Custom fields, custom entities, form and list designer, numbering series, picklists   |
| Levels      | Company config, with overrides per org unit (branch, campus…)                         |
| Publishing  | Draft, then publish, with version history and one-click rollback                      |
| Field types | Basic set, lookups/relations, files and images, formulas and auto fields              |
| Languages   | Every label and option has per-language text, falling back to the default             |
| Numbering   | Fiscal year from the country (India Apr–Mar); tokens like `{FY}` `{BRANCH}` `{SEQ:5}` |
| Logins      | WhatsApp OTP and Google/Microsoft move to Step 3                                      |

## 2. New services

| Service           | Owns                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config-service`  | All metadata: entities, fields, picklists, forms, list views, numbering series, versions and the layer merge. It also allocates document numbers.      |
| `records-service` | The data of **custom** entities: create, read, update and delete, validation, formulas, lookups, search and paging, org-unit scoping.                  |
| `file-service`    | File and image fields: signed upload/download URLs to S3-compatible storage (**MinIO** on the VPS; AWS S3 or Cloudflare R2 later with no code change). |

Built-in entities (users, org units, and later invoices or students) stay in their own services. They get **custom fields** through the same metadata: each built-in document gains a `custom` sub-document, validated against the published schema.

## 3. What can be configured (metadata model)

```
Entity        key, labels{en,hi,ar…}, pluralLabels, icon, kind (system|custom), orgScoped, titleField
Field         entity, key, type, labels, help, required, unique, default, validation, searchable,
              options (picklist) | target (lookup) | formula | numbering (auto-number)
Picklist      key, options[{value, labels, color, order, active}]
Form layout   entity, sections[{labels, columns: 1-3, fields[]}], read-only/required overrides
List view     entity, columns[], default sort, default filters, page size; users can save personal views
Numbering     key, pattern "INV/{FY}/{BRANCH}/{SEQ:5}", reset: never|yearly|monthly, scope: company|org-unit
```

**Field types:**

| Group     | Types                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Basic     | text, long text, number (integer), decimal, currency (amount plus ISO code, stored as Decimal128), percent, date (`YYYY-MM-DD`), date-time (UTC), time, yes/no, dropdown, multi-select, email, phone (E.164 with country), URL |
| Relations | lookup (one) or lookup (many) to any entity, including users and org units                                                                                                                                                     |
| Files     | file, image. Size and type limits are set per field                                                                                                                                                                            |
| Auto      | formula, auto-number, created by, created at, updated by, updated at, owner org unit                                                                                                                                           |

**Formulas** use a small, sandboxed expression language, never JavaScript `eval`. It covers arithmetic, text, date and conditional functions on the record's own fields, for example `qty * rate` or `IF(age >= 18, "Adult", "Minor")`. Formulas are evaluated on the server when a record is saved. Publish is rejected if the formulas depend on each other in a loop.

## 4. Layers and overrides

The effective config for a user is the published version of these layers, merged in order:

```
Platform base  →  Country Pack  →  Industry Pack  →  Company  →  Org unit (and its parents, top-down)
```

- Items merge **by key**, so a later layer adds or overrides.
- A pack can lock an item. For example, India's GST fields can't be removed, but their labels can change.
- An org unit override applies to that unit and everything below it, using the same path rule as permissions. For example, a campus can add extra admission fields or use its own number series.
- The merged result is cached per (tenant, org unit, version). When a new version is published, a `config.published` event clears that cache in every service.

Step 2 builds this layering mechanism. The real India and Education pack content comes in a later step.

## 5. Draft, publish, versions

- Each company has one **draft**. Admins edit it freely, and it never affects users.
- **Preview:** a designer can see a draft form or list exactly as users will.
- **Publish** checks the whole draft, then saves it as an **immutable version N**. The checks cover:
  - types and references
  - formula cycles
  - duplicate keys
  - numbering patterns
  - breaking changes
- **Breaking changes are guarded:**
  - A field that holds data can't be deleted, only **archived**: hidden, with its data kept.
  - A field's type can only change to a compatible type (for example, text to long text).
  - A required field is only added if it has a default or existing records are allowed to stay incomplete.
- **Rollback** publishes a copy of an older version as the new version, so history is never rewritten.
- Every publish and rollback goes to the audit log with a summary of the changes.

## 6. Records (custom entity data)

```
{ tenantId, entity, _id, number?, data: {fieldKey: value}, orgUnitId, orgPath,
  createdBy, createdAt, updatedBy, updatedAt, configVersion }
```

- The tenant plugin applies, as in Step 1, so tenants are isolated automatically.
- **Scoping by org unit:** a record belongs to an org unit, and users see records inside their permission scope, like the org tree.
- **Indexes:** fields marked _searchable_ or _unique_ get MongoDB partial indexes per (tenant, entity), created on publish.
- **Change history:** every create, update or delete emits an event with the fields that changed, so the audit log shows who changed what.

## 7. Permissions

- New fixed permissions:
  - `config.read`
  - `config.manage` (edit the draft)
  - `config.publish`
- **Per-entity permissions are generated** for each custom entity: `records.<entity>.read|create|update|delete`.
  - This extends Step 1's fixed permission list with keys that come from published config.
  - access-service checks new keys against config-service, and the role editor shows them automatically.
- Field-level rules come later: hide or make read-only per role (for example, salary visible only to HR).

## 8. Numbering series

- Counters are atomic per (series, scope, period) using `$inc`, so no duplicates happen, even under load.
- The period comes from the pattern and the company's fiscal year. The default comes from the Country Pack (India April–March, UAE and USA January–December), and the company can change it.
- Tokens: `{FY}` (for example 2026-27), `{YYYY}`, `{YY}`, `{MM}`, `{BRANCH}` (org unit code), `{SEQ:n}` (zero-padded).
- A number is assigned when the record is saved. A cancelled save can leave a gap, which is fine for admission or employee numbers. Legally gapless invoice numbers come with the finance module and its ledger.

## 9. Screens

**Config studio** (System Admin):

- Entities
- Fields, with a type picker and multilingual labels
- Form designer (drag-and-drop sections and fields)
- List view designer
- Picklists
- Numbering series
- Versions (draft changes, publish, history, compare, rollback)

**Runtime** (all users):

- Custom entities appear in the menu automatically.
- Lists use AG Grid and are driven by the list view.
- Forms use React Hook Form and are driven by the form layout, with validation generated from the field rules.
- Custom fields also appear on built-in screens (Users, Org units).

## 10. Step 2 acceptance criteria

1. An admin creates a custom entity (for example Student) with fields of every type, a form, a list and a number series, publishes it, and users can create, list, edit and delete records.
2. Custom fields added to Users and Org units appear and are validated.
3. A branch-level override (an extra field, its own number series) applies only to that branch and the units below it.
4. Draft changes are invisible until published; rollback restores the previous behaviour; publish rejects breaking changes and formula cycles.
5. Labels and options show in the user's language, falling back to the default.
6. Numbers follow the pattern and fiscal year and never repeat under concurrent saves (tested).
7. Files upload and download through signed URLs, and one tenant can't fetch another tenant's file.
8. Tenant isolation, generated per-entity permissions and org-unit scoping are proven by end-to-end tests, as in Step 1.
9. Every config publish and record change is in the audit chain; CI is green.

## 11. Not in Step 2 (planned order)

- **Step 3:** WhatsApp OTP login, Google and Microsoft sign-in.
- **Step 4:** Workflows and approvals, business rules, automations, notifications.
- **Step 5:** Print templates (invoice or receipt designer), report builder, dashboards.
- **Step 6:** Country Pack (India: GST, fiscal year, statutory fields) and Industry Packs (Education, Retail, Services, Healthcare), built on this engine.
- **Then:** business modules (masters, CRM, sales, accounting…), payments, AI.

## 12. Please confirm

1. The three new services: `config-service`, `records-service` and `file-service`.
2. **MinIO** on the VPS for files (S3-compatible, so it can move to S3 or R2 later). It adds one container and needs disk space.
3. The formula language is safe and limited. Anything more complex comes with the rules engine in Step 4.
4. The planned order for Steps 3 to 6 above, or tell me what matters most to you next.
