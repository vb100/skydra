import type { CompanyRecord, RegistryPerson, RegistryProvider } from './registry-provider';

/**
 * Synthetic registry for local and demo use (never in prod). Fixed company codes show each case a
 * broker must handle; any other code returns a simple company with one owner, so demos work with
 * whatever is typed. All people and companies are fictional.
 */
const person = (
  firstName: string,
  lastName: string,
  birthDate: string,
  personalCode: string,
  citizenship = 'LT',
): RegistryPerson => ({ firstName, lastName, birthDate, personalCode, citizenship });

const P = {
  jonas: person('Jonas', 'Savininkas', '1975-03-14', '37503140011'),
  ona: person('Ona', 'Akcininkė', '1982-07-02', '48207020022'),
  petras: person('Petras', 'Holdingas', '1968-11-20', '36811200033'),
  rimas: person('Rimas', 'Deklaruotas', '1979-05-05', '37905050044'),
  laura: person('Laura', 'Nedeklaruota', '1985-09-09', '48509090055'),
  tomas: person('Tomas', 'Vadovas', '1980-02-28', '38002280066'),
  karim: person('Karim', 'Al-Faris', '1971-04-04', 'AE710404', 'AE'),
};

const lt = (code: string, rest: Omit<CompanyRecord, 'code' | 'country' | 'references'>) =>
  ({
    code,
    country: 'LT',
    references: {
      JAR: `MOCK-JAR-${code}`,
      JADIS: `MOCK-JADIS-${code}`,
      JANGIS: `MOCK-JANGIS-${code}`,
    },
    ...rest,
  }) satisfies CompanyRecord;

export const MOCK_COMPANIES: Record<string, CompanyRecord> = {
  // 1. One owner, matching declaration.
  'LT:300000001': lt('300000001', {
    name: 'UAB „Paprasta įmonė“',
    legalForm: 'UAB',
    address: 'Gedimino pr. 10, Vilnius',
    manager: P.jonas,
    shareholders: [{ kind: 'NATURAL', person: P.jonas, sharePercent: 100 }],
    declaredUbos: [{ person: P.jonas, basis: 'OWNERSHIP', sharePercent: 100 }],
  }),
  // 2. Two levels: Petras owns 60 % through a holding company (60 % × 100 %).
  'LT:300000002': lt('300000002', {
    name: 'UAB „Grandinė“',
    legalForm: 'UAB',
    address: 'Laisvės al. 20, Kaunas',
    manager: P.ona,
    shareholders: [
      {
        kind: 'LEGAL',
        name: 'UAB „Holdingas“',
        code: '300000020',
        country: 'LT',
        sharePercent: 60,
      },
      { kind: 'NATURAL', person: P.ona, sharePercent: 40 },
    ],
    declaredUbos: [
      { person: P.petras, basis: 'OWNERSHIP', sharePercent: 60 },
      { person: P.ona, basis: 'OWNERSHIP', sharePercent: 40 },
    ],
  }),
  'LT:300000020': lt('300000020', {
    name: 'UAB „Holdingas“',
    legalForm: 'UAB',
    address: 'Laisvės al. 20, Kaunas',
    manager: P.petras,
    shareholders: [{ kind: 'NATURAL', person: P.petras, sharePercent: 100 }],
    declaredUbos: [{ person: P.petras, basis: 'OWNERSHIP', sharePercent: 100 }],
  }),
  // 3. JANGIS declares only one of two 50 % owners: a discrepancy to resolve.
  'LT:300000003': lt('300000003', {
    name: 'UAB „Neatitikimas“',
    legalForm: 'UAB',
    address: 'Tilžės g. 5, Klaipėda',
    manager: P.rimas,
    shareholders: [
      { kind: 'NATURAL', person: P.rimas, sharePercent: 50 },
      { kind: 'NATURAL', person: P.laura, sharePercent: 50 },
    ],
    declaredUbos: [{ person: P.rimas, basis: 'OWNERSHIP', sharePercent: 50 }],
  }),
  // 4. 80 % held by a company outside the EEA the registries know nothing about.
  'LT:300000004': lt('300000004', {
    name: 'UAB „Užsienio kapitalas“',
    legalForm: 'UAB',
    address: 'Ukmergės g. 100, Vilnius',
    manager: P.tomas,
    shareholders: [
      {
        kind: 'LEGAL',
        name: 'Gulf Holdings FZE',
        code: 'FZE-777',
        country: 'AE',
        sharePercent: 80,
      },
      { kind: 'NATURAL', person: P.tomas, sharePercent: 20 },
    ],
    declaredUbos: [{ person: P.karim, basis: 'CONTROL', sharePercent: null }],
  }),
};

/** A deterministic fictional owner for codes without a fixed scenario. */
function generic(country: string, code: string): CompanyRecord {
  const last4 = code.replace(/\D/g, '').padStart(4, '0').slice(-4);
  const owner = person('Vardenis', `Pavardenis-${last4}`, '1980-01-01', `380010${last4}9`);
  return {
    code,
    country,
    name: `Įmonė ${code}`,
    legalForm: country === 'LT' ? 'UAB' : null,
    address: null,
    manager: owner,
    shareholders: [{ kind: 'NATURAL', person: owner, sharePercent: 100 }],
    declaredUbos: [{ person: owner, basis: 'OWNERSHIP', sharePercent: 100 }],
    references: {
      JAR: `MOCK-JAR-${code}`,
      JADIS: `MOCK-JADIS-${code}`,
      JANGIS: `MOCK-JANGIS-${code}`,
    },
  };
}

export class MockRegistryProvider implements RegistryProvider {
  readonly mode = 'MOCK' as const;

  company(country: string, code: string): Promise<CompanyRecord | null> {
    const key = `${country.toUpperCase()}:${code.trim()}`;
    // Outside the EEA the simulated registries have no data, as with real Lithuanian registries.
    if (country.toUpperCase() === 'AE') return Promise.resolve(null);
    const record = MOCK_COMPANIES[key] ?? generic(country.toUpperCase(), code.trim());
    return Promise.resolve(structuredClone(record));
  }
}
