import { randomUUID } from 'node:crypto';
import type { MatchCategory, MatchStrength } from '@skydra/shared';
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
export const MOCK_MARKERS: {
  marker: string;
  category: MatchCategory;
  strength?: MatchStrength;
  details: object;
}[] = [
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
    // Below the threshold: shown folded, no review required.
    marker: 'panas',
    category: 'PEP',
    strength: 'WEAK',
    details: { position: 'Savivaldybės tarybos narys (imitacija)', country: 'LT' },
  },
];

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** A name containing this produces a simulated adverse-media article. */
export const MOCK_ARTICLE_MARKER = 'skandal';

/** Shaped like a Brave or GDELT result (see adverse-media/articles.ts). */
function mockArticle(subject: ScreeningSubject): ProviderMatch {
  const title = `${subject.name}: įtarimai dėl sukčiavimo (imitacija)`;
  return {
    externalId: 'naujienos.example.com/imitacija/straipsnis',
    name: title,
    score: null,
    strength: 'STRONG',
    categories: ['ADVERSE_MEDIA'],
    details: {
      kind: 'article',
      title,
      sourceUrl: 'https://example.com/imitacija/straipsnis',
      domain: 'naujienos.example.com',
      publishedAt: '2026-10-15T08:00:00.000Z',
      snippet: `Prokuratūra pradėjo ikiteisminį tyrimą: ${subject.name} įtariamas sukčiavimu ir pinigų plovimu. Tai imituotas straipsnis demonstracijai.`,
      source: 'Imitacija',
      terms: [subject.name, 'sukčiavim', 'pinigų plovim', 'įtariam'],
      simulated: true,
    },
  };
}

export class MockScreeningProvider implements ScreeningProvider {
  readonly mode = 'MOCK' as const;

  screen(subject: ScreeningSubject): Promise<ProviderResult> {
    const name = fold(subject.name);
    const matches: ProviderMatch[] = MOCK_MARKERS.filter((m) => name.includes(m.marker)).map(
      (m, i) => ({
        externalId: `mock-${m.category.toLowerCase()}-${i + 1}`,
        name: subject.name,
        score: m.strength === 'WEAK' ? 62 : 95,
        strength: m.strength ?? 'STRONG',
        categories: [m.category],
        details: {
          ...m.details,
          birthDate: subject.birthDate,
          countries: subject.countries,
          simulated: true,
        },
      }),
    );
    if (name.includes(MOCK_ARTICLE_MARKER)) matches.push(mockArticle(subject));
    return Promise.resolve({ reference: `mock-${randomUUID()}`, matches });
  }
}
