# Step 5: Print templates, reports and dashboards

> Status: **Implemented.** The owner approved this design on 2026-09-26, including the five points in section 7. Section 8 lists what differs from the design and the known limits.
> Date: 2026-09-25. Builds on [architecture.md](architecture.md), [step-2-config-engine.md](step-2-config-engine.md) and [step-4-workflows-rules.md](step-4-workflows-rules.md).

## 1. Decisions from the owner

| Topic           | Decision                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Print templates | **Block designer** with live preview, plus an **advanced HTML/CSS mode** for power users                     |
| PDF output      | **Headless Chromium** in its own service, for correct Indian scripts, Arabic (RTL), fonts and page breaks    |
| Reports         | List + group + totals, fields from **related records**, **pivot / cross-tab**, **scheduled email** reports   |
| Dashboards      | The **admin publishes dashboards per role**; users can also build **personal** dashboards from their reports |

## 2. What admins and users will see

**Config Studio, three new tabs:**

1. **Print templates**: pick an entity (e.g. Fee Receipt, Invoice) and build the page from blocks:
   - **Letterhead**: logo, company or branch name, address, tax numbers, all taken from the company and org-unit settings.
   - **Title and fields**: any field of the record, and of records it links to (`customer.name`, `customer.city`).
   - **Line items table**: columns, widths, alignment, totals row, "repeat header on every page".
   - **Totals**: sub-total, taxes, discount, grand total, **amount in words** in the chosen language and number system (lakh/crore or million).
   - **QR code or barcode**: the content is a formula, e.g. a payment link, or the record number.
   - **Text** with placeholders, **signature** (image and name), **terms**, **footer** with page numbers ("Page 1 of 3").
   - **Conditions** on any block (e.g. show "PAID" only when `STATUS() = "Paid"`) and a **watermark** by state (DRAFT, CANCELLED).
   - **Page setup**: A4, A5, Letter, or **thermal receipt 80 mm / 58 mm** (continuous height, for retail/POS); margins, portrait or landscape.
   - **Copies**: one PDF with several labelled copies, e.g. "Original / Duplicate", or "Student copy / Office copy".
   - **Language**: one language per template, or **bilingual** (e.g. English and Telugu side by side).
   - **Advanced mode**: switch a template to HTML/CSS with the same placeholders. The preview and the PDF stay identical.
2. **Reports**: see section 3.3.
3. **Dashboards**: see section 3.4.

All three follow the Step 2 draft → publish flow. They are versioned, can be rolled back, and can be overridden per org unit (e.g. a branch uses its own letterhead or receipt layout).

**Users:**

- On each record: a **Print** button (choose a template if there are several), **Download PDF**, and **Email PDF**.
- **Print several**: select records in a list and get one merged PDF (e.g. all fee receipts for today).
- A **Reports** page: the reports I may see, and, if allowed, **My reports** that I build myself. Each report has filters, drill-down to the records behind a number, and export to **Excel, CSV or PDF**.
- A **Home dashboard**: the dashboard for my role, with the option to switch to or build my own.

## 3. How it works

### 3.1 Print templates and PDFs (new `document-service`)

- The template is stored as blocks (a JSON layout). Blocks turn into HTML; advanced mode stores the HTML directly.
- Placeholders use a **safe, logic-less template language** (`{{record.amount}}`, `{{#each lines}}`, `{{format record.date "dd MMM yyyy"}}`). No scripts, no code. Conditions reuse the Step 2 formula language.
- **Formatting follows the company's settings**: currency, number grouping (12,34,567.00 in India), date format and language, all from reference data. No country-specific code.
- The PDF is made by **one headless Chromium** inside `document-service`:
  - Scripts are **turned off** and the network is **blocked**. Images (logo, signature, uploaded photos) are fetched from file-service first and embedded, so a template cannot reach other addresses.
  - **Fonts are bundled**: Noto Sans for Latin, Devanagari, Telugu, Tamil, Kannada, Malayalam, Bengali, Gujarati, Gurmukhi, Arabic and more. A company can upload its own fonts.
  - Renders are **queued**, 2 at a time. The browser restarts after a number of renders, to keep memory steady. Expected size: about 300–500 MB of RAM.
- **Where PDFs go**: straight to the browser for print and download. When emailed or kept, they are saved in file-service with a link to the record, so "the receipt we sent" can always be found again.
- **New automation action** (Step 4 engine): "**generate PDF** and email it / attach it to the record", e.g. "when the invoice is Approved, email the PDF to the customer".
- **Print several**: up to 200 records per merged PDF.

### 3.2 Line items

Invoices, quotations and orders need rows (item, quantity, rate, tax, amount). The engine has no such field yet. Two ways, both in this step:

- **New field type `table`** (recommended): rows stored inside the record, each column a normal field type, with **row formulas** (`qty * rate`) and **column totals** that other formulas can use (`SUM(lines.amount)`). Forms show an editable grid.
- **Related records**: for entities that already exist separately (e.g. Invoice Line with a lookup to Invoice), the print table can list "records of entity X that point to this record".

### 3.3 Reports

**Building a report** (Studio for admins, "My reports" for users):

1. Pick the **main entity** (e.g. Fee Payment).
2. Pick **columns**, including fields of **related records** through lookups, up to 2 hops (`Fee Payment → Student → Class`).
3. **Filters**, with **relative dates**: today, this week, this month, this quarter, this fiscal year, last fiscal year, last N days. Fiscal periods follow the company setting (India: April–March).
4. **Sort** and **group by** (up to 3 levels) with subtotals: count, sum, average, minimum, maximum, distinct count. Dates group by day, week, month, quarter or fiscal year.
5. **Pivot**: rows × columns, e.g. branch × month of fee collected, with row and column totals.
6. **Chart** (optional): bar, line, area, pie/donut, stacked bar.
7. **Run-time filters** the viewer can change (e.g. date range, branch, class).

**Where it runs:**

- Every report is turned into a **checked query** that runs inside `records-service`, the service that owns the data. The report definition never holds raw database commands.
- **The viewer's own access always applies**: only entities they may read, only records in their org units, and only fields they may see. A report shared with a branch head shows only that branch's numbers.
- **Limits** keep the VPS responsive: 10-second timeout per query; 500 rows per screen page; exports up to 100,000 rows, built in the background and emailed or downloaded when ready; pivots up to 200 columns.
- **Excel and PDF export** are built on the server (Excel with real numbers and formats, not text). The free AG Grid has no Excel or pivot, so both are done on the server and shown in the normal grid.

**Scheduled reports** (Step 4 scheduler):

- Daily, weekly or monthly at a chosen time in the company's time zone, as Excel, PDF or both, to chosen users or roles.
- **Each recipient gets only what they may see**: the report runs once per distinct access scope, not once as the sender.
- Up to 50 recipients per schedule; empty reports can be skipped.

### 3.4 Dashboards

- A dashboard is a grid of **widgets**:
  - **KPI tile**: one number with the change against the previous period (e.g. "Fees this month ₹4.2 L, ▲ 12%").
  - **Chart** from a report.
  - **List**: top N rows of a report.
  - **My approvals** and **My notifications** (from Step 4).
  - **Text / announcement** and **quick links** (e.g. "New admission").
- **Dashboard filters** apply to all widgets: date range and org unit.
- **Drill-down**: click a bar or a tile → the report behind it, filtered → the records behind that.
- **Who sees which**: the admin publishes dashboards and assigns them to roles (a role can have several; one is the home dashboard). Users can build **personal dashboards** from reports they can see, and can share one with a role if they have permission.
- **Speed**: widget results are cached for 5 minutes per company, dashboard and access scope, with a **Refresh** button. Widgets load in parallel.
- Works on phones (widgets stack in one column), with the PWA.
- Charts use **AG Charts Community** (free, MIT licence), which matches AG Grid.

### 3.5 Permissions and audit

| Permission                 | Allows                                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| `records.<entity>.read`    | Print and download PDFs of records you can read (no new permission)       |
| `reports.personal`         | Build My reports and personal dashboards                                  |
| `reports.share`            | Share a personal report or dashboard with a role                          |
| `reports.export`           | Export to Excel, CSV or PDF, and receive scheduled reports as attachments |
| `config.manage` (existing) | Build templates, company reports and dashboards in the Studio             |

Every **export**, **emailed PDF** and **scheduled report** is recorded in the audit chain (who, which report or record, how many rows). Printing on screen is not audited, to keep the log readable. Printing can be switched on per entity if a company needs it.

### 3.6 Where it lives

| Service                     | New responsibility                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| config-service              | Print templates, company reports and dashboards as new config kinds (draft, publish, versions, org-unit overrides)                    |
| records-service             | `table` field type; runs checked report queries (group, pivot, related records) with the viewer's access applied                      |
| **document-service** (new)  | Template rendering, headless Chromium PDFs, fonts, merged PDFs, PDF storage via file-service                                          |
| **reporting-service** (new) | My reports and personal dashboards, widget cache, Excel/CSV/PDF exports in the background, scheduled reports                          |
| workflow-service            | New automation action "generate PDF"; runs the scheduled-report jobs                                                                  |
| notification-service        | Email with attachments (PDFs and exports)                                                                                             |
| web                         | Studio tabs (template designer, report builder, dashboard builder), Print buttons, Reports page, Home dashboard, table field in forms |

Both new services follow the Step 1 pattern: their own database (`erp_document`, `erp_reporting`) and database user, the outbox, and tenant isolation tests.

## 4. Built-in examples (to prove it end to end)

- **Fee receipt** (Education): A5, English and Telugu, amount in words in lakh/crore, "Student copy / Office copy", PAID watermark.
- **Tax invoice** (Services): A4, line items table over 2+ pages with the header repeated, tax and grand totals, QR code.
- **POS receipt** (Retail): 80 mm thermal.
- **Report**: fee collected by branch × month (pivot) for this fiscal year, emailed every Monday at 08:00 to branch heads, each seeing only their branch.
- **Dashboard** "Branch head": fees this month, pending approvals, admissions by class chart, overdue fees list.

As in Step 4, these are built by the automated acceptance test. Ready-to-install versions come with the Industry Packs (Step 6).

## 5. Step 5 acceptance criteria

1. An admin builds the fee receipt and the invoice in the Studio without code, publishes, and prints. The preview and the PDF match. Rolling back restores the old layout.
2. Telugu, Hindi and Arabic text renders correctly (joined letters, right-to-left). Tables break across pages with repeated headers. The 80 mm receipt prints at the right width.
3. A template cannot run scripts or load outside addresses (tested).
4. The `table` field works in forms, formulas and totals, and prints.
5. Reports group, total, pivot and follow related records. The same report shows each user only the records and fields they may see (tested with two branches).
6. Excel export has real numbers. Large exports run in the background. Scheduled reports arrive on time (tests control the clock), each recipient scoped correctly.
7. Role dashboards and personal dashboards work, with filters, drill-down and caching. A user without access to a report cannot see its widget's data.
8. An org-unit override changes a branch's letterhead only.
9. Exports and emailed PDFs are in the audit chain, companies stay isolated, and CI is green.

## 6. Not in Step 5

- **Free-form drag-anywhere page canvas** (the block designer covers the needs; can come later on the same template model).
- **Country-specific documents** (GST e-invoice with IRN and signed QR, e-way bill, UAE e-invoicing): these come with the Country Packs in Step 6, using these templates.
- **Word (.docx) output**, and printing straight to a local printer without the browser's print dialog.
- **A separate analytics database** (e.g. ClickHouse) for very large data. Reports run on the live database with limits (section 3.3). This is planned when a client's data size needs it.
- **AI-generated reports** ("show me fees by branch"): after the core, with the AI layer.

## 7. Owner decisions (confirmed)

1. **Two new services**: `document-service` (PDFs, with Chromium, about 300–500 MB RAM) and `reporting-service` (personal reports, dashboards, exports, schedules).
2. **Add the `table` field type** (line items) in this step, as in section 3.2. Invoices and quotations need it.
3. **Scheduled reports run with each recipient's own access**, not the sender's. This is safer, but a report sent to many branches runs once per branch.
4. **Charts with AG Charts Community** (free), to match AG Grid.
5. **Audit**: exports, emailed PDFs and scheduled reports are audited; on-screen printing is not, unless a company turns it on per entity.

## 8. Implementation notes and known limits

### What differs from the design

- **Scheduled reports** run in reporting-service's own worker, not in workflow-service. It uses the same leased-job pattern, so several replicas never send the same schedule twice.
- **Audit of on-screen printing** is switched on per print template ("Record every print in the audit log"), not per entity.
- **Amounts in words** are in English, with the number system of the currency: lakh and crore for INR, PKR, NPR, LKR and BDT; million and billion for the others. Words in other languages come with the Country Packs.
- **Letterhead values** come from the org tree: `{{company.…}}` is the top unit (with the company name), `{{unit.…}}` is the record's own unit. Custom fields added to org units in the Studio (address, GSTIN, phone) can be printed, e.g. `{{unit.address}}`.
- **Linked records in reports** need permission to read the linked entity. A report showing `student.class.name` refuses to run for someone who cannot read students. Printed documents show linked and related records as the template's author chose, like any invoice shows the customer's name.
- **Drill-down** lists the records behind a number (click a group, a pivot cell or a bar) through the same report, so it needs no extra permission.
- **Excel and CSV** exports hold up to 100,000 rows; **PDF** exports up to 5,000 rows, because a PDF is for reading, not data.

### How it is built

| Part                                                                                                                                                                                  | Where                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Table fields, column aggregates (`SUM(lines.amount)`), print, report and dashboard definitions, validation, placeholders, relative dates and buckets, formatting and amounts in words | `packages/metadata` (`print.ts`, `reports.ts`, `report-paths.ts`, `dashboards.ts`, `dates.ts`, `format.ts`, `validate-outputs.ts`) |
| Report engine (rows, groups with subtotals, pivot, linked records up to two hops, prompts, date ranges, drill-down), document data                                                    | `records-service` (`report-engine.ts`, `document-data.ts`, internal `/internal/outputs/…`)                                         |
| Templates to HTML, headless Chromium, bundled Noto fonts, copies, merged PDFs, QR codes and barcodes, previews, email, automation output, report tables                               | `document-service` (new, port 3012, database `erp_document`)                                                                       |
| Company and personal reports, sharing, exports, schedules, dashboards and widget cache                                                                                                | `reporting-service` (new, port 3013, database `erp_reporting`)                                                                     |
| Email with attachments (`notify.mail.send`)                                                                                                                                           | `notification-service`                                                                                                             |
| Byte upload and download between services                                                                                                                                             | `file-service` (`/internal/files/bytes`)                                                                                           |
| The "document" automation action                                                                                                                                                      | `workflow-service`                                                                                                                 |
| `$lookup` allowed only when its pipeline matches the current tenant                                                                                                                   | `packages/tenancy`                                                                                                                 |
| Studio tabs (print, reports, dashboards), Reports pages, home dashboards, table input, print menu                                                                                     | `apps/web`                                                                                                                         |

- **Access.** reporting-service and document-service pass the viewer's access list to records-service with every request; records-service applies it to each query and join. Scheduled reports look up each recipient's access and group recipients with the same access, so the report runs once per group.
- **PDFs.** Chromium starts on the first render, runs at most two renders at a time (`RENDER_CONCURRENCY`), restarts after 200 renders, and has scripts off and every network request refused. Images (logos, signatures) are fetched from file-service first and embedded.
- **Fonts.** Noto Sans for Latin (with the rupee sign), Devanagari, Bengali, Gurmukhi, Gujarati, Tamil, Telugu, Kannada, Malayalam and Arabic are bundled; only the scripts a document uses are embedded in it.

### Configuration

| Service              | Settings                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| document-service     | `MONGO_PASSWORD_DOCUMENT` (new database user), `CHROMIUM_PATH` (`/usr/bin/chromium` in the image), `RENDER_CONCURRENCY` (default 2), `BROWSER_RECYCLE_AFTER` (default 200) |
| reporting-service    | `MONGO_PASSWORD_REPORTING` (new database user), `SCHEDULER_INTERVAL_MS` (default 15000)                                                                                    |
| notification-service | `FILE_SERVICE_URL` for attachments                                                                                                                                         |
| workflow-service     | `DOCUMENT_SERVICE_URL` for the "document" action                                                                                                                           |

Existing servers: add `MONGO_PASSWORD_DOCUMENT` and `MONGO_PASSWORD_REPORTING` to `.env.production` before `docker compose up`; `mongo-init` then creates the two database users.

### Known limits

| Area                                 | Behaviour today                                                                                    | Planned                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Amounts in words                     | English only                                                                                       | Hindi, Telugu, Arabic and others with the Country Packs |
| Reports on line items                | Reports cover an entity's records, not the rows of its table fields                                | Item-wise reports (one row per line item)               |
| Mixed currencies                     | Sums add amounts as numbers; a report mixing currencies needs a currency filter                    | Totals per currency                                     |
| Branch overrides of reports          | Reports and dashboards run with the company definitions; branch overrides apply to print templates | Per-branch report definitions                           |
| Dashboard cache                      | Per reporting-service instance, 5 minutes                                                          | Shared cache (Redis) when running several replicas      |
| Letterhead for company-wide entities | Records without an org unit print the company name only                                            | A company profile (address, tax numbers) in settings    |
| Report size                          | Reports run on the live database with a 10-second limit (60 seconds for exports)                   | An analytics store for very large data                  |
