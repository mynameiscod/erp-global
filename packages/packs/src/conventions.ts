/**
 * How Industry Packs and Country Packs fit together without naming each other.
 *
 * Industry Packs declare what their entities are with **roles**; Country Packs patch
 * every entity with a role (fields, line columns, tax settings, documents, reports).
 * An entity with a role follows the shape below, so the patches find what they need.
 */
export const ROLES = {
  /** A buyer: customer, client, patient, student's guardian… Needs a `name` text field. */
  customer: 'customer',
  /** Something sold: product, service, fee head. Needs `name` and `price` (currency). */
  item: 'item',
  /**
   * A tax document for a sale (invoice, POS bill, fee receipt…). Needs:
   *  - `customer`: lookup to an entity with the `customer` role (may be optional)
   *  - `date`: date field
   *  - line items: a table field named in `tax.lines`, with columns `item` (lookup to an
   *    entity with the `item` role), `qty` (integer or decimal), `rate` (currency, usually
   *    `defaultFrom: 'item.price'`) and `amount` (formula `qty * rate`)
   *  - `tax: { lines, amount: 'amount', document: 'invoice' }` (the country fills the rest)
   */
  salesInvoice: 'sales_invoice',
  /** A credit note or sales return: the same shape as a sales invoice. */
  creditNote: 'credit_note',
  /** An item that is usually exempt from tax (e.g. school fees); countries default it to exempt. */
  taxExempt: 'tax_exempt',
} as const;
