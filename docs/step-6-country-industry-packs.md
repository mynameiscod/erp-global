# Step 6: Country Pack (India) and Industry Packs

> Status: **Approved** by the owner on 2026-09-26 ("ok go ahead"), including the five points in section 7. Implementation in progress.
> Date: 2026-09-26. Builds on [architecture.md](architecture.md) and Steps 2–5.

## 1. Decisions from the owner

| Topic              | Decision                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| India Country Pack | **GST core + returns data**: GSTIN/PAN, HSN/SAC, GST rates, CGST+SGST or IGST by place of supply, GST invoice and credit note templates, Indian fiscal year and numbering, holidays, GSTR-1 and GSTR-3B summaries. e-Invoice (IRN) and e-way bill come later. |
| Industry Packs     | **A starter kit for each of the four**: Education, Retail, Services, Healthcare                                                                                                                                                                               |
| Installing packs   | **The admin chooses** on a Packs page. Nothing installs by itself; a setup checklist suggests the packs for the company's country and industry.                                                                                                               |
| Tax                | **A generic tax engine driven by country data.** India GST is data on it; UAE VAT or US sales tax become more data later, not new code.                                                                                                                       |

## 2. What admins and users will see

**A new Packs page** (Settings → Packs), for people with the new `packs.manage` permission:

- A **catalog** of Country Packs and Industry Packs, each with its version, what it adds, and whether it is installed. The packs for the company's country and industry are marked "Suggested".
- **Install**: shows what the pack adds (entities, fields, templates, reports, roles, tax data) and puts it into the Studio **draft**. The admin reviews it and **publishes**, as with any change (Step 2). Nothing reaches users before publishing.
- **Sample data** (optional, on install): a few example records (students, items, invoices) to try the pack out, removable with one click.
- **Upgrade**: when a newer pack version ships, the admin sees what changed. Anything the company changed itself is **kept**; where the pack changed the same item, the admin chooses "keep mine" or "take the pack's".
- **Remove**: the pack's configuration is taken out of the draft. **Data is never deleted**: fields and entities that hold records are archived, as with any published field.

**Everything a pack installs can be changed in the Studio**, like the company's own configuration. The pack is a starting point, not a lock. (Fields a Country Pack marks as statutory, e.g. GSTIN, can be hidden but not retyped or removed.)

**For users** (after an Industry Pack and the India pack are published), for example in a school:

- Menus for Students, Classes, Admissions, Fee structures and Fee receipts, with forms, lists and number series ready.
- A fee receipt and a GST tax invoice ready to print, bilingual where the company chooses.
- Reports (fees collected, dues, GST summaries) and a dashboard for the role (Principal, Accountant, Front office).

## 3. How it works

### 3.1 Packs are data

A pack is a versioned bundle of **configuration and data, never code**:

- **Configuration**: the same items the Studio builds: entities, fields, option lists, forms, lists, number series, workflows, rules, automations, message and print templates, reports, dashboards, settings.
- **Tax data** (Country Packs): tax categories, rates, components and the rules that pick them (3.3).
- **Identifier types** (Country Packs): e.g. GSTIN, PAN, with their format and check digit (3.4).
- **Holidays and working week** (Country Packs), for approval reminders and due dates.
- **Role templates**: named roles with their permissions (e.g. "Accountant"), created when the pack is installed and editable afterwards.
- **Sample records** (optional).

Packs live in the repository (`packs/…`), are checked by the same validation as the Studio, and are released with the platform. A pack may **require capabilities** (e.g. "tax engine") but **never a specific country**: the Education pack works with the India pack, a future UAE pack, or none.

### 3.2 Layers and upgrades

The configuration a user sees is built from layers, in order:

```
platform base  →  Country Pack  →  Industry Pack(s)  →  company  →  branch overrides
```

- Each installed pack is its own layer, so **upgrading a pack replaces only its layer**. The company's changes live in the company layer on top and are kept.
- A **conflict** is an item the pack changed in the new version _and_ the company changed too (e.g. both edited the Admission workflow). The upgrade screen lists them; the admin keeps theirs or takes the pack's.
- Removing or upgrading a pack never breaks data: published fields that disappear are archived (the Step 2 rule), and records are never touched.
- Pack layers are part of each published configuration version, so **rolling back** restores the packs as they were.

### 3.3 The tax engine (country-neutral)

**Tax data** (from the Country Pack, editable in the Studio under a new "Taxes" tab):

- **Components**: e.g. CGST, SGST, IGST, Cess (India); VAT (UAE); state and county tax (USA).
- **Categories**: what an item or service is taxed at, e.g. "GST 18%", "GST 5%", "Exempt", "Nil rated", "Zero rated (export)". Each category gives the **rate per component**.
- **Rules** that choose the components for a sale, using conditions in the Step 2 formula language over the context:
  - `seller.region`, `buyer.region`, `buyer.country`, `buyer.registered` (has a GSTIN), `supply.reverseCharge`
  - India: same state → CGST + SGST (half the rate each); different state → IGST; outside India → zero rated (export).

**Using it on an entity** (e.g. Invoice): the admin turns on **"Calculate taxes"** and maps:

- the line items table, its amount column and its tax category column (or HSN/SAC code, which carries a default category)
- where the seller's region comes from (the org unit's state) and the buyer's (the customer's state, or a place-of-supply field)
- whether prices include tax

On every save, the server adds per line the tax components, rates and amounts; and per record a **tax summary** (component, rate, taxable value, tax) with `tax_total` and `grand_total`. These are ordinary calculated fields, so print templates, reports and formulas use them. The same engine runs in the browser for instant totals; **the server is the authority**.

Amounts are rounded per component and line as the country's data says (India: to the paisa per line; invoice total to the rupee, if the company chooses).

### 3.4 India Country Pack (`country.in`)

- **Identifiers** with format and check-digit validation: **GSTIN** (15 characters, state code, PAN inside, checksum), **PAN**, and **pincode**. A GSTIN's first two digits must match the chosen state.
- **States and union territories** with their GST state codes (36), as an option list.
- **Fields added**:
  - org units: GSTIN, PAN, state, address (the branch's registration; used by letterheads)
  - customers and vendors where an Industry Pack defines them: GSTIN, state, "registered / unregistered"
  - items and services: HSN/SAC code, tax category
- **GST data**: components CGST, SGST, IGST and compensation cess; categories 0%, 0.25%, 3%, 5%, 12%, 18%, 28% (+ cess), Exempt, Nil, Non-GST, Zero rated; the place-of-supply rules above; reverse charge.
- **Documents**: GST **tax invoice**, **bill of supply** (for exempt supplies or composition dealers), **credit note** and **debit note** templates (A4, English with an optional second language), with the declarations and fields GST rules require (GSTIN of both parties, place of supply, HSN/SAC summary, amounts in words, "Original for recipient / Duplicate for supplier" copies).
- **Numbering**: invoice series per financial year (April–March), at most 16 characters as GST requires, e.g. `INV/{FY}/{SEQ:5}` gives `INV/26-27/00001`.
- **Reports** (from invoice and credit note data), exportable to Excel:
  - **GSTR-1 summary**: B2B invoices by customer GSTIN; B2C large (inter-state, over the threshold) and B2C small by state and rate; credit and debit notes; **HSN summary**; documents issued.
  - **GSTR-3B summary**: outward taxable supplies by rate, inter-state supplies to unregistered persons by state. (Input tax credit comes with the purchase module.)
- **Holidays**: national holidays for the year, plus a working week setting (e.g. Monday–Saturday). Approval reminders and escalations (Step 4) can count **working hours only**.
- **Formats**: Indian digit grouping and dates are already per locale (Step 2); amounts in words in **Hindi** are added (English exists).

### 3.5 Line-item reports

GST summaries need numbers per line (HSN summary). Reports gain a **"one row per line item"** mode: pick an entity and one of its table fields; columns and filters can use the line's columns and the record's fields (e.g. HSN code, rate, taxable value, invoice date, customer state). Grouping, totals and exports work as in Step 5.

### 3.6 The four Industry Packs (starter kits)

Each pack installs entities, forms, lists, number series, workflows, print templates, reports, a role dashboard and role templates. Companies adjust them in the Studio.

| Pack           | Entities                                                                                                                   | Workflows and automations                                                                                  | Documents                                                            | Reports and dashboard                                                                                            | Roles                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Education**  | Academic year, Class and section, Student, Guardian, Admission, Fee head, Fee structure, Fee receipt (line items), Fee due | Admission: applied → verified → approved → admitted (creates the student); fee due reminders 3 days before | Fee receipt (A5, bilingual, student/office copies), admission letter | Fees collected by class and month, dues by class, admissions funnel; **Principal** and **Accountant** dashboards | Principal, Accountant, Front office, Teacher |
| **Retail**     | Item (with HSN, tax category, price, barcode), Customer, Sale (POS bill with line items), Sales return                     | Low-stock alert (by a reorder field, until inventory comes)                                                | 80 mm POS receipt, A4 tax invoice                                    | Sales by day, by item, by payment mode; **Store manager** dashboard                                              | Store manager, Cashier                       |
| **Services**   | Client, Contact, Service (with SAC), Quotation, Invoice (line items), Payment                                              | Quotation approval above an amount; invoice PDF emailed when approved                                      | Quotation, tax invoice, payment receipt                              | Invoiced vs paid by client, ageing of dues; **Owner** dashboard                                                  | Owner, Sales, Accounts                       |
| **Healthcare** | Patient, Doctor, Appointment, Visit (consultation), Bill (line items), Payment                                             | Appointment reminder the day before (email/WhatsApp)                                                       | Appointment slip, visit bill / receipt, prescription note            | Appointments by doctor, revenue by service; **Front desk** and **Doctor** dashboards                             | Doctor, Front desk, Billing                  |

Taxes: when the India pack is installed, invoices and bills in these packs use the tax engine (e.g. education fees are usually exempt; retail items and services carry GST categories). Without a Country Pack they work without tax.

### 3.7 Where it lives

| Service                       | New responsibility                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **pack-service** (new, small) | The pack catalog, installations per company, install / upgrade / remove as audited jobs; applies pack content through the owners' internal APIs  |
| config-service                | Pack layers in the draft and in each published version; conflict detection on upgrade; new config kinds for taxes, identifier types and holidays |
| records-service               | Tax calculation on save; identifier validation; line-item reports; sample records                                                                |
| access-service                | Roles created from pack role templates                                                                                                           |
| workflow-service              | Working-hours timers from the holidays and working week                                                                                          |
| metadata (package)            | Pack manifest, tax engine (shared by server and browser), identifier check digits (GSTIN, PAN), Hindi amounts in words                           |
| web                           | Packs page, Studio "Taxes" tab, tax settings on entities, setup checklist                                                                        |

New permission: `packs.manage`. Every install, upgrade and removal is recorded in the audit chain.

## 4. Built-in examples (to prove it end to end)

- A new company in India (education) installs **India** and **Education** from the Packs page, publishes, and immediately has students, admissions, fee structures and fee receipts working, with the Principal dashboard.
- A services company in Hyderabad (Telangana) invoices a client in Telangana (CGST 9% + SGST 9%) and one in Karnataka (IGST 18%); the invoice PDF shows the HSN/SAC summary and both GSTINs; the GSTR-1 summary lists them under B2B, with the HSN summary.
- A retail shop's POS bill on 80 mm paper with GST included in prices.
- The company edits the Education pack's Admission form; a new pack version then changes the same form: the upgrade shows the conflict and keeps the company's version unless told otherwise.

## 5. Step 6 acceptance criteria

1. The Packs page lists packs; installing puts the pack into the draft; publishing makes it live; removing it keeps all records (fields archived).
2. Upgrading a pack keeps the company's changes and shows real conflicts; rolling back a published version restores the pack layers.
3. GSTIN and PAN are validated (format, check digit, state code); wrong values are refused with a clear message.
4. Taxes are calculated on save for intra-state, inter-state, export, exempt and reverse-charge cases, with correct rounding; the browser shows the same totals.
5. GST invoice, bill of supply and credit note PDFs carry the required fields; the GSTR-1 and GSTR-3B summaries match hand-calculated totals (tested).
6. Line-item reports work, including grouping and exports.
7. Each of the four Industry Packs installs and works with and without the India pack; its workflows, documents, reports and dashboards run.
8. Approval reminders can count working hours and skip holidays.
9. Everything is in the audit chain, companies stay isolated, no country or industry names appear in core code (checked by a test), and CI is green.

## 6. Not in Step 6

- **e-Invoice (IRN, signed QR) and e-way bill** through a GST Suvidha Provider: the next India step, when a GSP account is chosen.
- **GST return filing** (uploading to the GST portal): the summaries are for review and for the accountant or filing tool.
- **Input tax credit** and purchase GST: with the purchase and accounting modules.
- **TDS/TCS, payroll statutory items** (PF, ESI, professional tax): with accounting and payroll.
- **Other Country Packs** (UAE, USA, UK, Singapore, Australia): the tax engine and pack model are ready for them; their data comes next, in the agreed order.
- **Deeper industry modules** (timetables, exams and report cards, inventory, pharmacy, lab): later steps.
- **A pack marketplace** for third parties: later; Step 6 packs are first-party.

## 7. Owner decisions (confirmed)

1. **A small new `pack-service`** for the catalog and installations (as planned in the architecture). Alternative: keep it inside config-service to save one container on the VPS.
2. **Pack content ships with the platform** (in the repository, released with it). Packs from an online catalog or partners come later.
3. **Statutory fields are protected**: fields a Country Pack marks as statutory (e.g. GSTIN on invoices) can be hidden or relabelled but not removed or retyped, so GST documents stay complete.
4. **Hindi amounts in words** are added with the India pack. Telugu, Tamil and others follow when you want them (they need checking by a native speaker).
5. **Education fees default to "Exempt"** in the Education pack when India is installed; the school can change the category per fee head.

## 8. Implementation notes and known limits

### What differs from the design

- **Role keys.** A pack cannot know the ids of the roles it creates, so pack roles carry a `key` (e.g. `principal`, `svc_owner`). Reports, dashboards, workflow actions (`roleKeys`), approvers and notification recipients (`{ type: 'role', roleKey }`) can name a role by key. Roles are created once, by key, when the pack is first published; later edits by the admin are kept.
- **Conventions instead of dependencies.** Industry Packs never name the India pack. Their entities declare roles (`customer`, `item`, `sales_invoice`, `credit_note`, `tax_exempt`), and a Country Pack patches every entity with a role: GST fields, line columns, tax settings, GST documents and returns. So packs can be installed in any order, and a second country later needs no change to the industries. When two entities share a role (e.g. retail sales and services invoices), the country's reports and documents are made for each of them, with the entity in the name.
- **Sample data** is loaded on request from the Packs page, not at install. It is created in order. `@ref` values, table rows included, become the ids of earlier samples, and everything is taken back if one record fails. Each sample has a source key, so "Add" never creates duplicates, and "Remove" deletes only the samples (soft, audited), never the company's own records.
- **Forms show every field.** A field that a form layout does not place (e.g. GSTIN added by the India pack to an Industry Pack's form) appears in a "More details" section at the end of the form, so a Country Pack's fields are never hidden by a form written without them.
- **Pack removal** archives what the pack brought and that was published (entities, fields, their option lists and number series). Fields a Country Pack added to the removed pack's entities are archived with them. Records are kept and stay reachable.

### How it is built

| Part                                                                                                                                                                                                                            | Where                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Tax engine (components, categories, rules with conditions, per-line rounding, inclusive prices, reverse charge, round-off, summary by component and rate), identifiers with check digits, work calendar, Hindi amounts in words | `packages/metadata` (`tax.ts`, `identifiers.ts`, `dates.ts`, `format.ts`) |
| Pack manifest, pack layers (role patches with `$entity`/`$lines`), install, upgrade with conflicts, remove and retire; locked statutory fields                                                                                  | `packages/metadata` (`packs.ts`, `pack-ops.ts`, `validate.ts`)            |
| India pack and the four Industry Packs, as data                                                                                                                                                                                 | `packages/packs` (`country-in.ts`, `industry-*.ts`)                       |
| Catalog, suggestions, install/upgrade/remove into the draft, installation history, sample data, pack roles after publish                                                                                                        | `pack-service` (new, port 3014, database `erp_pack`)                      |
| Packs in the draft and in each version; published pack manifests                                                                                                                                                                | `config-service` (`/internal/config/packs…`)                              |
| Tax on save (regions from a field, a linked record or the org unit), `defaultFrom`, identifier checks, line-item reports, sample removal                                                                                        | `records-service`                                                         |
| Pack roles by key; role holders by key                                                                                                                                                                                          | `access-service`                                                          |
| Working-hours reminders and escalations; approvers, recipients and actions by role key                                                                                                                                          | `workflow-service`                                                        |
| Reports and dashboards for role keys                                                                                                                                                                                            | `reporting-service`                                                       |
| Packs page, setup step, Studio taxes, calendar and identifiers, entity tax settings, tax panel with live preview, "More details", identifier inputs, line-item report builder                                                   | `apps/web`                                                                |

- **Tests.** Every pack is checked on its own, with India installed before and after it, and all five together; every sample is validated and its references checked. The e2e tests install India and Services for a Hyderabad company, check GSTINs, CGST+SGST within Telangana and IGST to Karnataka, the GSTR-1 HSN summary, sample data and removal. A second e2e test installs all five packs in one company, loads every pack's samples through the real services, and runs every company report and dashboard. A test checks that core code names no statutory taxes, identifiers or industry records.

### Configuration

| Service      | Settings                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| pack-service | `MONGO_PASSWORD_PACK` (new database user), `CONFIG_SERVICE_URL`, `RECORDS_SERVICE_URL`, `ACCESS_SERVICE_URL`, `TENANT_SERVICE_URL`, `ORG_SERVICE_URL` |
| api-gateway  | `PACK_SERVICE_URL` (`/api/v1/packs`)                                                                                                                  |

Existing servers: add `MONGO_PASSWORD_PACK` to `.env.production` before `docker compose up`; `mongo-init` then creates the database user. The Tenant Admin role gets `packs.manage` automatically; give it to other roles in Roles if needed.

### Known limits

| Area                               | Behaviour today                                                                                                                                                             | Planned                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Cross-record updates               | An automation changes only its own record: a payment does not update its invoice's amount received, a receipt does not mark a fee due as paid, a sale does not reduce stock | Automation actions on linked records; totals over related records |
| Converting documents               | An accepted quotation or an admission cannot create an invoice or a guardian with its lines and a link back                                                                 | "Create from" actions that copy lines and link records            |
| Which template an automation sends | An Industry Pack's automation emails its own invoice template; with India it is not the GST invoice                                                                         | Choosing a template by document kind                              |
| Reports for "me"                   | Reports cannot filter by the viewing user (a doctor sees all of today's appointments)                                                                                       | A "current user" filter                                           |
| Ageing                             | Reports cannot compare dates with today minus N days; the Services pack updates ageing nightly with an automation                                                           | Relative date buckets in reports                                  |
| Messages to customers              | WhatsApp and SMS go to users only; guardians and patients get emails                                                                                                        | Phone-number recipients                                           |
| Sensitive fields                   | No field-level masking; clinical notes are protected by entity permissions only                                                                                             | Masked and audited fields                                         |
| Pack text in the preview           | The install preview lists items in English                                                                                                                                  | Localised preview                                                 |
| Tax preview in the browser         | Uses the units the user can see to find the seller's state; the amounts saved are always calculated by the server                                                           | —                                                                 |
