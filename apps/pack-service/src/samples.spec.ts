import { resolveSampleRefs } from './samples';

describe('sample references', () => {
  const ids = new Map([
    ['svc_web', 'a'.repeat(24)],
    ['client', 'b'.repeat(24)],
  ]);

  it('resolves references at any depth, table rows included', () => {
    expect(
      resolveSampleRefs(
        {
          customer: '@client',
          branch: '@unit',
          email: 'a@b.test',
          lines: [{ item: '@svc_web', qty: 2 }],
        },
        ids,
        'c'.repeat(24),
      ),
    ).toEqual({
      customer: 'b'.repeat(24),
      branch: 'c'.repeat(24),
      email: 'a@b.test',
      lines: [{ item: 'a'.repeat(24), qty: 2 }],
    });
  });

  it('refuses a reference to a sample not created earlier', () => {
    expect(() => resolveSampleRefs({ item: '@missing' }, ids, 'u')).toThrow(/@missing/);
  });
});
