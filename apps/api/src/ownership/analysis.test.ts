import { describe, expect, it } from 'vitest';
import { analyseOwnership } from './analysis';
import { MOCK_COMPANIES, MockRegistryProvider } from './mock-registry';
import type { CompanyRecord } from './registry-provider';

const records = new Map(Object.entries(MOCK_COMPANIES));
const analyse = (key: string, threshold = 25) =>
  analyseOwnership(MOCK_COMPANIES[key]!, records, threshold);
const summary = (key: string) =>
  analyse(key).ubos.map((u) => [
    u.person.lastName,
    u.basis,
    u.effectivePercent,
    u.computed,
    u.declared,
  ]);

describe('ownership analysis', () => {
  it('a single owner matching the declaration', () => {
    const a = analyse('LT:300000001');
    expect(a).toMatchObject({ depth: 1, incomplete: false, discrepancy: false, issues: [] });
    expect(summary('LT:300000001')).toEqual([['Savininkas', 'OWNERSHIP', 100, true, true]]);
  });

  it('computes indirect shares through a holding company', () => {
    const a = analyse('LT:300000002');
    expect(a).toMatchObject({ depth: 2, incomplete: false, discrepancy: false });
    expect(a.tree[0]).toMatchObject({
      kind: 'LEGAL',
      effectivePercent: 60,
      children: [{ kind: 'NATURAL', name: 'Petras Holdingas', effectivePercent: 60 }],
    });
    expect(summary('LT:300000002')).toEqual([
      ['Holdingas', 'OWNERSHIP', 60, true, true],
      ['Akcininkė', 'OWNERSHIP', 40, true, true],
    ]);
  });

  it('flags an owner missing from the declaration', () => {
    const a = analyse('LT:300000003');
    expect(a.discrepancy).toBe(true);
    expect(a.issues).toContain('DECLARED_UBOS_DIFFER');
    expect(summary('LT:300000003')).toEqual([
      ['Deklaruotas', 'OWNERSHIP', 50, true, true],
      ['Nedeklaruota', 'OWNERSHIP', 50, true, false],
    ]);
  });

  it('an untraceable foreign owner makes the chain incomplete; the manager is the fallback', () => {
    const a = analyse('LT:300000004');
    expect(a.incomplete).toBe(true);
    expect(a.issues).toEqual(
      expect.arrayContaining(['UNRESOLVED_OWNER:Gulf Holdings FZE', 'NO_OWNER_AT_THRESHOLD']),
    );
    expect(a.tree[0]).toMatchObject({ unresolved: true, children: [] });
    expect(summary('LT:300000004')).toEqual([
      ['Vadovas', 'SENIOR_MANAGING_OFFICIAL', null, true, false],
      ['Al-Faris', 'CONTROL', null, false, true],
    ]);
  });

  it('uses the threshold as data and sums several paths to the same person', () => {
    expect(analyse('LT:300000002', 50).ubos.filter((u) => u.computed)).toHaveLength(1);
    const twice: CompanyRecord = {
      ...MOCK_COMPANIES['LT:300000002']!,
      shareholders: [
        { kind: 'LEGAL', name: 'H', code: '300000020', country: 'LT', sharePercent: 15 },
        { kind: 'NATURAL', person: MOCK_COMPANIES['LT:300000020']!.manager!, sharePercent: 15 },
        { kind: 'NATURAL', person: MOCK_COMPANIES['LT:300000002']!.manager!, sharePercent: 70 },
      ],
    };
    const a = analyseOwnership(twice, records, 25);
    expect(a.ubos.find((u) => u.person.lastName === 'Holdingas')?.effectivePercent).toBe(30);
  });

  it('detects shares not adding up and ownership cycles', () => {
    const odd: CompanyRecord = {
      ...MOCK_COMPANIES['LT:300000001']!,
      shareholders: [
        { kind: 'NATURAL', person: MOCK_COMPANIES['LT:300000001']!.manager!, sharePercent: 70 },
      ],
    };
    expect(analyseOwnership(odd, records, 25).incomplete).toBe(true);

    const a: CompanyRecord = {
      ...MOCK_COMPANIES['LT:300000001']!,
      code: 'A',
      shareholders: [{ kind: 'LEGAL', name: 'B', code: 'B', country: 'LT', sharePercent: 100 }],
    };
    const b: CompanyRecord = {
      ...a,
      code: 'B',
      shareholders: [{ kind: 'LEGAL', name: 'A', code: 'A', country: 'LT', sharePercent: 100 }],
    };
    const cyclic = analyseOwnership(
      a,
      new Map([
        ['LT:A', a],
        ['LT:B', b],
      ]),
      25,
    );
    expect(cyclic.incomplete).toBe(true);
    expect(cyclic.issues).toContain('CYCLE:A');
  });

  it('the mock registry knows nothing outside the EEA and invents simple companies otherwise', async () => {
    const mock = new MockRegistryProvider();
    expect(await mock.company('AE', 'FZE-777')).toBeNull();
    const any = await mock.company('lt', '123456789');
    expect(any).toMatchObject({ country: 'LT', shareholders: [{ sharePercent: 100 }] });
    expect(analyseOwnership(any!, new Map(), 25).discrepancy).toBe(false);
  });
});
