import type { lt } from './lt';

/** Every language has the keys of the Lithuanian texts, with its own strings. */
type Widen<T> = { readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Messages = Widen<typeof lt>;

export const LOCALES = ['lt', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** {{name}} placeholders, as i18next uses them, for texts rendered outside React (the PDF). */
export function format(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    values[key] === undefined ? '' : String(values[key]),
  );
}
