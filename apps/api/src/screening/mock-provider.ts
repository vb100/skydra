import { randomUUID } from 'node:crypto';
import type { MatchCategory } from '@skydra/shared';
import type {
  ProviderMatch,
  ProviderResult,
  ScreeningProvider,
  ScreeningSubject,
} from './provider';

/**
 * Simulated results for local and demo use, never allowed in prod (see config/env.ts).
 * Deterministic, so demos and tests can show each outcome: a name containing one of the markers
 * below produces that kind of potential match; any other name produces none.
 */
export const MOCK_MARKERS: { marker: string; category: MatchCategory; details: object }[] = [
  {
    marker: 'sankcij',
    category: 'SANCTIONS',
    details: { regime: 'ES sankcijų sąrašas (imitacija)', measures: ['Turto įšaldymas'] },
  },
  {
    marker: 'politik',
    category: 'PEP',
    details: { position: 'Seimo narys (imitacija)', country: 'LT', tier: 'PEP 1' },
  },
  {
    marker: 'artimas',
    category: 'PEP_ASSOCIATE',
    details: { relation: 'Šeimos narys (imitacija)' },
  },
  {
    marker: 'skandal',
    category: 'ADVERSE_MEDIA',
    details: { summary: 'Neigiama informacija žiniasklaidoje (imitacija)' },
  },
];

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export class MockScreeningProvider implements ScreeningProvider {
  readonly mode = 'MOCK' as const;

  screen(subject: ScreeningSubject): Promise<ProviderResult> {
    const name = fold(subject.name);
    const matches: ProviderMatch[] = MOCK_MARKERS.filter((m) => name.includes(m.marker)).map(
      (m, i) => ({
        externalId: `mock-${m.category.toLowerCase()}-${i + 1}`,
        name: subject.name,
        score: m.category === 'ADVERSE_MEDIA' ? 80 : 95,
        categories: [m.category],
        details: {
          ...m.details,
          birthDate: subject.birthDate,
          countries: subject.countries,
          simulated: true,
        },
      }),
    );
    return Promise.resolve({ reference: `mock-${randomUUID()}`, matches });
  }
}
