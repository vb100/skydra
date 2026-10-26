import { describe, expect, it } from 'vitest';
import { MockScreeningProvider } from './mock-provider';
import type { ScreeningSubject } from './provider';

const subject = (name: string): ScreeningSubject => ({
  partyType: 'NATURAL',
  name,
  birthDate: null,
  countries: ['LT'],
});

describe('mock screening provider', () => {
  const mock = new MockScreeningProvider();

  it('finds nothing for ordinary names', async () => {
    expect((await mock.screen(subject('Jonas Jonaitis'))).matches).toEqual([]);
  });

  it('produces the outcome named by a marker, ignoring case and diacritics', async () => {
    const result = await mock.screen(subject('Ona POLITIKĖ-Skandalė'));
    expect(result.matches.map((m) => m.categories)).toEqual([['PEP'], ['ADVERSE_MEDIA']]);
    expect(result.matches[0]!.details).toMatchObject({ simulated: true });
    expect(result.reference).toMatch(/^mock-/);
  });
});
