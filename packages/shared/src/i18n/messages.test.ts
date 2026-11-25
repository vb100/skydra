import { describe, expect, it } from 'vitest';
import { en } from './en';
import { lt } from './lt';
import { format } from './messages';

/** Every text with its path, e.g. ["screening.statuses.RED", "…"]. */
function texts(tree: object, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string'
      ? [[`${prefix}${key}`, value] as [string, string]]
      : texts(value as object, `${prefix}${key}.`),
  );
}
const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('translations', () => {
  const ltTexts = new Map(texts(lt));
  const enTexts = new Map(texts(en));

  it('English has every Lithuanian key and no other', () => {
    expect([...enTexts.keys()].sort()).toEqual([...ltTexts.keys()].sort());
  });

  it('the same placeholders in both languages, and no empty text', () => {
    for (const [key, text] of ltTexts) {
      expect(placeholders(enTexts.get(key)!), key).toEqual(placeholders(text));
      expect(enTexts.get(key)!.trim().length, key).toBeGreaterThan(0);
    }
  });

  it('fills placeholders outside React', () => {
    expect(format(en.report.title, { reference: 'AML-2026-0001' })).toBe('AML case AML-2026-0001');
    expect(format('{{a}} – {{missing}}', { a: 1 })).toBe('1 – ');
  });
});
