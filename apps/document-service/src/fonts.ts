import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Noto fonts bundled with the service, so every script prints the same on any
 * server: Latin, Indian scripts and Arabic. Only the fonts a document needs are
 * embedded in it.
 */
interface ScriptFont {
  family: string;
  pkg: string;
  subset: string;
  /** Characters that need this font. */
  test: RegExp;
}

export const SCRIPT_FONTS: ScriptFont[] = [
  {
    family: 'Noto Sans Devanagari',
    pkg: 'noto-sans-devanagari',
    subset: 'devanagari',
    test: /[\u0900-\u097F]/,
  },
  {
    family: 'Noto Sans Bengali',
    pkg: 'noto-sans-bengali',
    subset: 'bengali',
    test: /[\u0980-\u09FF]/,
  },
  {
    family: 'Noto Sans Gurmukhi',
    pkg: 'noto-sans-gurmukhi',
    subset: 'gurmukhi',
    test: /[\u0A00-\u0A7F]/,
  },
  {
    family: 'Noto Sans Gujarati',
    pkg: 'noto-sans-gujarati',
    subset: 'gujarati',
    test: /[\u0A80-\u0AFF]/,
  },
  { family: 'Noto Sans Tamil', pkg: 'noto-sans-tamil', subset: 'tamil', test: /[\u0B80-\u0BFF]/ },
  {
    family: 'Noto Sans Telugu',
    pkg: 'noto-sans-telugu',
    subset: 'telugu',
    test: /[\u0C00-\u0C7F]/,
  },
  {
    family: 'Noto Sans Kannada',
    pkg: 'noto-sans-kannada',
    subset: 'kannada',
    test: /[\u0C80-\u0CFF]/,
  },
  {
    family: 'Noto Sans Malayalam',
    pkg: 'noto-sans-malayalam',
    subset: 'malayalam',
    test: /[\u0D00-\u0D7F]/,
  },
  {
    family: 'Noto Sans Arabic',
    pkg: 'noto-sans-arabic',
    subset: 'arabic',
    test: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/,
  },
];

const LATIN: ScriptFont = { family: 'Noto Sans', pkg: 'noto-sans', subset: 'latin', test: /./ };
/** Also carries the rupee sign and other currency symbols. */
const LATIN_EXT: ScriptFont = {
  family: 'Noto Sans',
  pkg: 'noto-sans',
  subset: 'latin-ext',
  test: /[\u0100-\u024F\u20A0-\u20C0]/,
};

const RANGE_RE = /unicode-range:\s*([^;]+);/;
const cache = new Map<string, string>();

/** One @font-face rule, with the unicode range fontsource publishes for the subset. */
function face(f: ScriptFont, weight: 400 | 700): string {
  const key = `${f.pkg}-${f.subset}-${weight}`;
  let rule = cache.get(key);
  if (rule === undefined) {
    const root = dirname(require.resolve(`@fontsource/${f.pkg}/package.json`));
    const name = `${f.pkg}-${f.subset}-${weight}-normal`;
    const data = readFileSync(join(root, 'files', `${name}.woff2`)).toString('base64');
    const css = readFileSync(join(root, `${weight}.css`), 'utf8');
    const block = css.split('@font-face').find((b) => b.includes(`${name}.woff2`)) ?? '';
    const range = RANGE_RE.exec(block)?.[1];
    rule =
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${weight};` +
      `font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');` +
      (range ? `unicode-range:${range};` : '') +
      '}';
    cache.set(key, rule);
  }
  return rule;
}

/** @font-face rules for the scripts used in `text`, and the font-family stack to use. */
export function fontCss(text: string): { css: string; family: string } {
  const used = [
    LATIN,
    ...(LATIN_EXT.test.test(text) ? [LATIN_EXT] : []),
    ...SCRIPT_FONTS.filter((f) => f.test.test(text)),
  ];
  const families = [...new Set(used.map((f) => `'${f.family}'`))];
  return {
    css: used.flatMap((f) => [face(f, 400), face(f, 700)]).join('\n'),
    family: [...families, 'sans-serif'].join(', '),
  };
}
