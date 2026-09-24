import type { LocalizedText } from './types';

/**
 * Picks the best text for `lang`: exact tag (`hi-IN`), then base language (`hi`),
 * then the fallback language, then English, then any text there is.
 */
export function pickText(text: LocalizedText | undefined, lang: string, fallback = 'en'): string {
  if (!text) return '';
  const base = lang.split('-')[0];
  return text[lang] ?? text[base] ?? text[fallback] ?? text.en ?? Object.values(text)[0] ?? '';
}
