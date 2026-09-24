import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import bootstrapLtr from 'bootstrap/dist/css/bootstrap.min.css?url';
import bootstrapRtl from 'bootstrap/dist/css/bootstrap.rtl.min.css?url';
import { UI_LANGUAGES } from '@erp/contracts';
import { setApiLanguage } from '../api/client';
import ar from './locales/ar.json';
import en from './locales/en.json';
import hi from './locales/hi.json';

const STORAGE_KEY = 'erp.language';
export const RTL_LANGUAGES = new Set<string>(
  UI_LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code),
);

function initialLanguage(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch {
    /* storage may be unavailable */
  }
  const browser = navigator.language?.split('-')[0];
  return UI_LANGUAGES.some((l) => l.code === browser) ? browser : 'en';
}

/** Switches `dir`, `lang` and the Bootstrap build (LTR or RTL). */
function applyDocument(lang: string): void {
  const rtl = RTL_LANGUAGES.has(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = rtl ? 'rtl' : 'ltr';
  let link = document.getElementById('bootstrap-css') as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = 'bootstrap-css';
    link.rel = 'stylesheet';
    document.head.prepend(link);
  }
  const href = rtl ? bootstrapRtl : bootstrapLtr;
  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  setApiLanguage(lang);
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi }, ar: { translation: ar } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

applyDocument(i18n.language);
i18n.on('languageChanged', (lang) => {
  applyDocument(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
});

export default i18n;
