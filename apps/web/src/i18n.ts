import { LOCALES, type Locale, MESSAGES } from '@skydra/shared';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const KEY = 'skydra.language';

/** The language chosen on this device; Lithuanian by default (client answer Q10). */
export function storedLanguage(): Locale {
  try {
    const value = localStorage.getItem(KEY);
    return LOCALES.find((l) => l === value) ?? 'lt';
  } catch {
    return 'lt';
  }
}

void i18n.use(initReactI18next).init({
  resources: Object.fromEntries(LOCALES.map((l) => [l, { translation: MESSAGES[l] }])),
  lng: storedLanguage(),
  fallbackLng: 'lt',
  interpolation: { escapeValue: false },
});
document.documentElement.lang = i18n.language;

/** Switches the interface language and remembers it on this device. */
export function setLanguage(language: Locale): void {
  void i18n.changeLanguage(language);
  document.documentElement.lang = language;
  try {
    localStorage.setItem(KEY, language);
  } catch {
    // Storage may be unavailable (private mode); the language still applies for this page.
  }
}

/** The interface language as a locale code. */
export const currentLanguage = (): Locale => LOCALES.find((l) => l === i18n.language) ?? 'lt';

/** Number formats of the interface language. */
export const numberLocale = (): string => (currentLanguage() === 'en' ? 'en-GB' : 'lt-LT');

export default i18n;
