export * from './access';
export * from './cases';
export * from './documents';
export * from './kyc';
export * from './ownership';
export * from './progress';
export * from './risk';
export * from './runtime';
export * from './work';
export * from './screening';
export { lt, type Translations } from './i18n/lt';
export { en } from './i18n/en';
export { format, LOCALES, type Locale, type Messages } from './i18n/messages';
import { en } from './i18n/en';
import { lt } from './i18n/lt';
import type { Locale, Messages } from './i18n/messages';
/** The texts of each language. */
export const MESSAGES: Record<Locale, Messages> = { lt, en };
