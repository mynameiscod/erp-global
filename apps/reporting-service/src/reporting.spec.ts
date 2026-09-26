import type { ReportResult } from '@erp/metadata';
import { display, flatten } from './tables';
import { nextScheduleRun } from './zoned-time';

describe('flattening results for exports', () => {
  it('puts subtotals after the rows they add up, then the grand total', () => {
    const result: ReportResult = {
      kind: 'groups',
      columns: [
        { key: 'g0', label: 'City', type: 'text' },
        { key: 'g1', label: 'Mode', type: 'text' },
        { key: 'a0', label: 'Sum', type: 'currency', currency: 'INR' },
      ],
      rows: [
        {
          level: 0,
          keys: { g0: 'b', g1: 'cash' },
          labels: { g0: 'Bengaluru', g1: 'Cash' },
          values: { a0: 10 },
        },
        {
          level: 0,
          keys: { g0: 'h', g1: 'cash' },
          labels: { g0: 'Hyderabad', g1: 'Cash' },
          values: { a0: 20 },
        },
        {
          level: 0,
          keys: { g0: 'h', g1: 'upi' },
          labels: { g0: 'Hyderabad', g1: 'UPI' },
          values: { a0: 5 },
        },
      ],
      subtotals: [
        { level: 1, keys: { g0: 'b' }, labels: { g0: 'Bengaluru' }, values: { a0: 10 } },
        { level: 1, keys: { g0: 'h' }, labels: { g0: 'Hyderabad' }, values: { a0: 25 } },
      ],
      grandTotal: { a0: 35 },
      truncated: false,
    };
    const t = flatten(result);
    expect(t.rows).toEqual([
      ['Bengaluru', 'Cash', 10],
      ['Bengaluru', 'Total', 10],
      ['Hyderabad', 'Cash', 20],
      ['Hyderabad', 'UPI', 5],
      ['Hyderabad', 'Total', 25],
      ['Total', '', 35],
    ]);
    expect([...t.totals]).toEqual([1, 4, 5]);
    expect(display(t.columns[2], 1234567.5, { locale: 'en-IN', timezone: 'UTC' })).toBe(
      '₹12,34,567.50',
    );
  });

  it('spreads a pivot into one column per value, with totals', () => {
    const result: ReportResult = {
      kind: 'pivot',
      rowColumns: [{ key: 'g0', label: 'Branch', type: 'text' }],
      columnKeys: [
        { key: '2026-04', label: '2026-04' },
        { key: '2026-05', label: '2026-05' },
      ],
      values: [{ key: 'a0', label: 'Fees', type: 'currency', currency: 'INR' }],
      rows: [
        {
          keys: { g0: 'x' },
          labels: { g0: 'HYD' },
          cells: { '2026-04': { a0: 100 }, __total: { a0: 100 } },
        },
      ],
      columnTotals: { '2026-04': { a0: 100 }, '2026-05': { a0: 0 } },
      grandTotal: { a0: 100 },
      truncated: false,
    };
    const t = flatten(result);
    expect(t.columns.map((c) => c.label)).toEqual(['Branch', '2026-04', '2026-05', 'Total']);
    expect(t.rows).toEqual([
      ['HYD', 100, null, 100],
      ['Total', 100, 0, 100],
    ]);
  });
});

describe('schedule times', () => {
  const tz = 'Asia/Kolkata';
  it('finds the next daily, weekly and monthly run in the company time zone', () => {
    // Thursday 24 Sep 2026, 10:00 IST.
    const now = new Date('2026-09-24T04:30:00Z');
    expect(nextScheduleRun(now, { frequency: 'daily', at: '09:00' }, tz).toISOString()).toBe(
      '2026-09-25T03:30:00.000Z',
    );
    expect(nextScheduleRun(now, { frequency: 'daily', at: '11:00' }, tz).toISOString()).toBe(
      '2026-09-24T05:30:00.000Z',
    );
    expect(
      nextScheduleRun(now, { frequency: 'weekly', at: '08:00', weekday: 1 }, tz).toISOString(),
    ).toBe('2026-09-28T02:30:00.000Z');
    expect(
      nextScheduleRun(now, { frequency: 'monthly', at: '08:00', monthDay: 1 }, tz).toISOString(),
    ).toBe('2026-10-01T02:30:00.000Z');
  });
});
