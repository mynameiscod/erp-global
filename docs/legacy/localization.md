# H. Globalization Strategy

## 0. Concepts that stay separate

| Concept | Is | Is not |
|---|---|---|
| **Language** (`te`, `ar`) | the language of UI text and documents | a country or formatting convention |
| **Locale** (`te-IN`, `ar-AE`, `en-IN`) | a BCP 47 tag driving CLDR formatting (numbers, dates, collation, numbering system) | a language pack; the same language can have many locales |
| **Language Pack** | versioned translation bundles for UI keys (and pack keys) | a Country Pack; installing `language.ar` implies no tax or legal rules |
| **Country Pack** | jurisdiction rules: tax, identifiers, statutory formats, address formats | UI translations |
| **Timezone** | IANA zone per user (display) and per legal entity (business dates) | derived from locale |
| **Currency** | an ISO 4217 attribute of each monetary value | derived from locale or language |

Other rules:
- **Unicode everywhere:** UTF-8 end to end, NFC normalization on input, ICU collation for sorting,
  and no assumptions about string length or byte size (grapheme-aware truncation).
- **No English UI text is a domain constant:** enums and statuses are codes, labels are keys.
- **RTL is architectural:** direction comes from the language (CLDR) and flows through layout
  primitives (see §5).
- **Two translation systems:**
  - UI translation: language packs, keys, versioned, with a review status.
  - Business-data translation: `translatable` fields per record in `record_translation` or
    `<table>_translation`, managed by tenants.

## 1. Independent dimensions

Language, locale (formatting), timezone, currency, calendar, measurement system, address format
and phone format are **independent settings** resolved by cascade:

```
document/portal override → user preference → org unit / legal entity default → tenant default → platform fallback
```

A user in Dubai can work in English UI, `ar-AE` number formatting, Asia/Dubai time, Hijri
calendar display, on a legal entity whose functional currency is AED and whose invoices print in
Arabic + English.

## 2. UI text: translation keys only

- Every user-visible string is a key: `finance.journal.status.posted`, `pack.edu.field.admissionNumber`.
- Messages use **ICU MessageFormat** (plurals, gender/select, number/date args) —
  FormatJS (`react-intl`) on the web, ICU4J `MessageFormat` on the server (emails, PDFs, errors).
- Lint rule (`eslint` custom rule + `i18next`-style literal-string detector) fails the build on
  JSX literal text; backend ArchUnit rule forbids user-facing literals in exceptions (errors carry
  keys + params, see RFC 9457 in [architecture.md](architecture.md#8-cross-cutting-concerns)).
- Namespaces are lazy-loaded per module/pack; missing keys fall back along the chain
  (`te-IN → te → en`) and are reported to the Language Pack Studio's "missing" queue.
- Metadata labels (entity/field names from Studio) are keys too; Studio creates the key and the
  default-language text in one step.

## 3. Multilingual business data

Fields flagged `translatable` store per-locale values in `record_translation` (metadata records)
or `<table>_translation` tables (hardened entities, e.g. `inventory.item_translation`). Reading
resolves the requested locale with fallback; documents choose locale per document (customer's
preferred language), not per user.

## 4. Language Pack Studio

Import/export (XLIFF 2.x, JSON, CSV), missing-translation detection, fallback preview, AI
translation (status `MACHINE`), human review (`HUMAN_VERIFIED`), legal review (`LEGAL_VERIFIED`)
for legal texts, versioning, translation memory (exact + fuzzy matches reused across tenants only
for platform/pack strings — never tenant business data). Approved translations are never silently
overwritten.

## 5. RTL

- `dir` is derived from the active language (CLDR character order), set on `<html>` and on any
  subtree rendering content in a different direction (e.g. an English code inside Arabic text
  uses `<bdi>`).
- CSS uses **logical properties only** (`margin-inline-start`, `padding-inline-end`, `inset-inline`);
  a Stylelint rule bans physical `left/right` properties in component code.
- Directional icons (arrows, chevrons, progress, undo/redo) flip via a `dir`-aware icon wrapper;
  non-directional icons (search, checkmarks, media play in some conventions) don't.
- Tables, breadcrumbs, steppers, charts' axis order, drawers and modals mirror correctly;
  verified by visual regression tests in `ar` and `he`.
- PDFs/documents: the template engine renders with an RTL-capable HTML-to-PDF pipeline with
  bidi support and embedded Noto fonts (Arabic, Hebrew, Devanagari, Telugu, CJK…).
- Mobile/POS (Flutter): `Directionality` driven by the same language data, ARB catalogs generated
  from the ICU messages, and `EdgeInsetsDirectional`-only layouts. Receipt printers get a rasterized
  RTL receipt when the device lacks bidi support.

## 6. Locale formatting

- Numbers, currencies, percentages, dates, times, units, lists and relative times via **CLDR**
  data: browser `Intl` APIs on the web, ICU4J on the server. No hand-written format strings.
- Numbering systems (Arabic-Indic, Devanagari digits) follow locale preference; input fields
  accept both native and Latin digits and normalize.
- Measurement system (metric/US/imperial) is a preference; quantities are stored in the item's
  base UoM with conversion tables, displayed in preferred units where a mapping exists.
- Addresses: format templates and required fields per country from the Country Pack
  (libaddressinput data); phone numbers stored E.164, validated with libphonenumber.

## 7. Time and calendars

- Instants stored as `timestamptz` in UTC. Business dates (`posting_date`, `due_date`) are
  `date` values meaningful in the **legal entity timezone**; the server computes "today" per
  legal entity, not per server.
- Scheduling stores local wall-clock time + IANA timezone for recurring events (so DST shifts
  behave correctly) and materializes instants.
- **Calendars:** internal representation is always ISO/Gregorian. Display and input support
  Gregorian, Islamic (Umm al-Qura / civil), Buddhist, Japanese, Persian via `Intl.DateTimeFormat`
  `calendar` option and ICU4J `Calendar` subclasses. Fiscal years/periods are defined as Gregorian
  date ranges (a Hijri-aligned fiscal year is simply ranges generated by the pack) so ledger
  logic never deals with calendar arithmetic.
- Holiday calendars are data (per country/region/org unit) used by scheduling, SLAs and
  business-day functions.

## 8. Currencies

- ISO 4217 catalog with minor units; cash-rounding rules (e.g. CHF 0.05) from Country Packs.
- Every monetary value is `(amount, currency)`. Documents carry transaction currency; ledger
  lines carry transaction, functional and reporting amounts with the exact FX rate id used.
- FX: rate sources as adapters (ECB, central banks, provider feeds, manual), rate types (spot,
  average, closing), effective dates, manual override with audit. Realized FX gain/loss on
  settlement; unrealized via period-end revaluation journals (reversible). Consolidation uses
  configured rate types per account class.

## 9. Testing

Localization test matrix in CI: `en-US`, `te-IN`, `hi-IN`, `ar-AE` (RTL), `he-IL` (RTL),
`de-DE` (long words, comma decimals), `ja-JP` (CJK, Japanese calendar), with timezone edge cases
(`Asia/Kolkata` +05:30, `Asia/Kathmandu` +05:45, `America/New_York` DST, `Pacific/Kiritimati`
+14) and currencies with 0/2/3 minor units (JPY, USD, KWD/BHD/OMR).
