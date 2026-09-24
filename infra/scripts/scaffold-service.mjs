// Creates the boilerplate for a backend service: package.json, tsconfigs, jest config.
// Usage: node infra/scripts/scaffold-service.mjs <name> [extra-dep@range ...]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [name, ...extra] = process.argv.slice(2);
if (!name) throw new Error('service name required');
const dir = join(import.meta.dirname, '..', '..', 'apps', name);
mkdirSync(join(dir, 'src'), { recursive: true });

const deps = {
  '@erp/auth': 'workspace:*',
  '@erp/contracts': 'workspace:*',
  '@erp/events': 'workspace:*',
  '@erp/service-kit': 'workspace:*',
  '@erp/tenancy': 'workspace:*',
  '@nestjs/common': '^11.1.0',
  '@nestjs/core': '^11.1.0',
  '@nestjs/platform-express': '^11.1.0',
  '@nestjs/swagger': '^11.2.0',
  mongoose: '^8.18.0',
  'nestjs-pino': '^4.4.0',
  'reflect-metadata': '^0.2.2',
  rxjs: '^7.8.1',
  zod: '^4.1.0',
};
for (const e of extra) {
  const at = e.lastIndexOf('@');
  deps[e.slice(0, at)] = e.slice(at + 1);
}

const pkg = {
  name: `@erp/${name}`,
  version: '0.1.0',
  private: true,
  scripts: {
    build: 'tsc -p tsconfig.build.json',
    dev: 'tsc-watch -p tsconfig.build.json --onSuccess "node --env-file-if-exists=../../.env dist/main.js"',
    start: 'node dist/main.js',
    typecheck: 'tsc -p tsconfig.json --noEmit',
    lint: 'eslint src',
    test: 'jest',
  },
  dependencies: Object.fromEntries(Object.entries(deps).sort()),
  devDependencies: {
    '@erp/testing': 'workspace:*',
    '@nestjs/testing': '^11.1.0',
    '@types/express': '^5.0.0',
    '@types/jest': '^29.5.14',
    '@types/supertest': '^6.0.2',
    jest: '^29.7.0',
    supertest: '^7.1.0',
    'ts-jest': '^29.4.0',
  },
};

const write = (file, content) => {
  const p = join(dir, file);
  if (!existsSync(p)) writeFileSync(p, content);
};
write('package.json', JSON.stringify(pkg, null, 2) + '\n');
write(
  'tsconfig.json',
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: { rootDir: 'src', outDir: 'dist', types: ['jest', 'node'] },
      include: ['src'],
    },
    null,
    2,
  ) + '\n',
);
write(
  'tsconfig.build.json',
  JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: { types: ['node'], declaration: false },
      exclude: ['src/**/*.spec.ts'],
    },
    null,
    2,
  ) + '\n',
);
write('jest.config.js', "module.exports = require('../../jest.preset.js')(__dirname);\n");
console.log(`scaffolded apps/${name}`);
