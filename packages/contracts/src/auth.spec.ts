import { hasPermission, isPathInScope, scopePathsFor } from './auth';

describe('hasPermission', () => {
  const claims = {
    acl: [
      { ou: 'b', path: '/a/b/', p: ['org.unit.create' as const] },
      { ou: 'a', path: '/a/', p: ['org.unit.read' as const] },
    ],
  };

  it('grants at the assigned unit and below', () => {
    expect(hasPermission(claims, 'org.unit.create', '/a/b/')).toBe(true);
    expect(hasPermission(claims, 'org.unit.create', '/a/b/c/')).toBe(true);
  });

  it('denies above or beside the assigned unit', () => {
    expect(hasPermission(claims, 'org.unit.create', '/a/')).toBe(false);
    expect(hasPermission(claims, 'org.unit.create', '/a/bx/')).toBe(false);
  });

  it('denies a permission that is not granted', () => {
    expect(hasPermission(claims, 'audit.event.read')).toBe(false);
  });

  it('honours platform permissions', () => {
    expect(hasPermission({ acl: [], plat: ['platform.tenant.read'] }, 'platform.tenant.read')).toBe(
      true,
    );
  });

  it('returns scope paths', () => {
    expect(scopePathsFor(claims, 'org.unit.read')).toEqual(['/a/']);
    expect(isPathInScope('/a/z/', ['/a/'])).toBe(true);
    expect(isPathInScope('/q/', ['/a/'])).toBe(false);
  });
});
