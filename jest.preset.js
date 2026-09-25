const path = require('path');

const PACKAGES = ['contracts', 'metadata', 'tenancy', 'auth', 'events', 'service-kit', 'testing'];

/** Shared Jest config. Workspace packages resolve to their TypeScript source, so tests need no build. */
module.exports = function preset(dir, overrides = {}) {
  const root = __dirname;
  const moduleNameMapper = {};
  for (const p of PACKAGES) {
    moduleNameMapper[`^@erp/${p}$`] = path.join(root, 'packages', p, 'src');
  }
  return {
    rootDir: dir,
    testEnvironment: 'node',
    testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    transform: {
      '^.+\\.ts$': [
        'ts-jest',
        {
          tsconfig: path.join(dir, 'tsconfig.json'),
          diagnostics: { ignoreCodes: [6059, 6307, 151001, 151002] },
        },
      ],
    },
    moduleNameMapper,
    testTimeout: 60000,
    // On GitHub Actions, failures also become annotations, readable without opening the logs.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],
    ...overrides,
  };
};
