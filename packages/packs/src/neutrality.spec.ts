import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Country and industry knowledge lives in packs, as data. Core code (services, shared
 * packages, the web app) must not name statutory taxes, identifiers or industry records;
 * comments and tests may, as examples.
 */
const ROOT = join(__dirname, '..', '..', '..');
const CORE = [
  'apps',
  'packages/metadata/src',
  'packages/contracts/src',
  'packages/service-kit/src',
  'packages/tenancy/src',
  'packages/auth/src',
  'packages/events/src',
];
const FORBIDDEN =
  /\b(gstin|gstr\w*|cgst|sgst|igst|utgst|hsn|sac_code|pan_number|aadhaar|vat_number|student|patient|guardian|admission|fee_receipt|pos_bill)\b/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (['node_modules', 'dist', 'locales', '.turbo'].includes(name)) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Code without comments (a simple pass; good enough for this check). */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

it('keeps country and industry names out of core code', () => {
  const hits: string[] = [];
  const files = CORE.flatMap((dir) => sources(join(ROOT, dir)));
  expect(files.length).toBeGreaterThan(200);
  for (const file of files) {
    code(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        const m = FORBIDDEN.exec(line);
        if (m) hits.push(`${relative(ROOT, file)}:${i + 1} ${m[0]}`);
      });
  }
  expect(hits).toEqual([]);
});
