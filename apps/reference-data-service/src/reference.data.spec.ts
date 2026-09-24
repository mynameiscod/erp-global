import {
  getCountry,
  listCountries,
  listCurrencies,
  listLanguages,
  listTimezones,
} from './reference.data';

describe('reference data', () => {
  it('covers every ISO country', () => {
    expect(listCountries().length).toBeGreaterThanOrEqual(240);
  });

  it('describes India', () => {
    expect(getCountry('in')).toMatchObject({
      code: 'IN',
      name: 'India',
      currencies: ['INR'],
      callingCodes: ['+91'],
      timezones: ['Asia/Kolkata'],
      defaultLocale: 'en-IN',
      continent: 'Asia',
    });
  });

  it('localizes names', () => {
    expect(getCountry('AE', 'ar')?.name).toBe('الإمارات العربية المتحدة');
    expect(getCountry('IN', 'hi')?.name).toBe('भारत');
  });

  it('knows currency symbols and decimals', () => {
    const byCode = new Map(listCurrencies().map((c) => [c.code, c]));
    expect(byCode.get('INR')).toMatchObject({ symbol: '₹', decimals: 2 });
    expect(byCode.get('JPY')).toMatchObject({ decimals: 0 });
    expect(byCode.get('KWD')).toMatchObject({ decimals: 3 });
  });

  it('lists languages and time zones', () => {
    expect(listLanguages().find((l) => l.code === 'ar')?.nativeName).toBe('العربية');
    expect(listTimezones().find((t) => t.id === 'Asia/Dubai')?.countries).toContain('AE');
  });
});
