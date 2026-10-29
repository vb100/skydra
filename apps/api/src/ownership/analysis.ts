import type { CompanyRecord, RegistryPerson } from './registry-provider';

export type OwnershipNode = {
  kind: 'NATURAL' | 'LEGAL';
  name: string;
  code: string | null;
  country: string | null;
  sharePercent: number;
  /** Share of the analysed company held through this path. */
  effectivePercent: number;
  /** A legal owner the registries have no data for. */
  unresolved: boolean;
  children: OwnershipNode[];
};

export type UboCandidate = {
  /** Stable identity: personal code, else name and birth date. */
  key: string;
  person: RegistryPerson;
  basis: 'OWNERSHIP' | 'CONTROL' | 'SENIOR_MANAGING_OFFICIAL';
  effectivePercent: number | null;
  computed: boolean;
  declared: boolean;
};

export type OwnershipAnalysis = {
  thresholdPercent: number;
  tree: OwnershipNode[];
  /** Persons to identify and screen: computed and declared, merged. */
  ubos: UboCandidate[];
  depth: number;
  /** Some owners could not be traced or shares do not add up to 100 %. */
  incomplete: boolean;
  /** Computed (JADIS) and declared (JANGIS) beneficial owners differ. */
  discrepancy: boolean;
  issues: string[];
};

const MAX_DEPTH = 6;

export function personKey(p: RegistryPerson): string {
  if (p.personalCode) return `code:${p.personalCode.replace(/[\s-]/g, '').toUpperCase()}`;
  return `name:${p.firstName} ${p.lastName}:${p.birthDate ?? ''}`.toLowerCase();
}

const personName = (p: RegistryPerson) => `${p.firstName} ${p.lastName}`;
const round = (n: number) => Math.round(n * 100) / 100;
const companyKey = (country: string, code: string) => `${country.toUpperCase()}:${code}`;

/**
 * Traces ownership of a company through the registry records, computes indirect shares
 * (e.g. 60 % × 100 % = 60 %), finds beneficial owners at or above the threshold and compares
 * them with the declared ones. Without any owner at the threshold the senior managing official
 * (the manager) is the beneficial owner. Pure: same records, same answer.
 */
export function analyseOwnership(
  root: CompanyRecord,
  records: ReadonlyMap<string, CompanyRecord>,
  thresholdPercent: number,
): OwnershipAnalysis {
  const issues: string[] = [];
  const owners = new Map<string, { person: RegistryPerson; percent: number }>();
  let depth = 0;
  let incomplete = false;

  function walk(
    company: CompanyRecord,
    factor: number,
    level: number,
    path: string[],
  ): OwnershipNode[] {
    depth = Math.max(depth, level);
    const total = company.shareholders.reduce((sum, s) => sum + s.sharePercent, 0);
    if (Math.abs(total - 100) > 0.5) {
      incomplete = true;
      issues.push(`SHARES_NOT_100:${company.name}:${round(total)}`);
    }
    return company.shareholders.map<OwnershipNode>((s) => {
      const effective = factor * s.sharePercent;
      if (s.kind === 'NATURAL') {
        const key = personKey(s.person);
        const prev = owners.get(key);
        owners.set(key, { person: s.person, percent: (prev?.percent ?? 0) + effective });
        return {
          kind: 'NATURAL',
          name: personName(s.person),
          code: null,
          country: s.person.citizenship,
          sharePercent: s.sharePercent,
          effectivePercent: round(effective),
          unresolved: false,
          children: [],
        };
      }
      const key = companyKey(s.country, s.code);
      const child = records.get(key);
      const cyclic = path.includes(key);
      const unresolved = !child || cyclic || level + 1 > MAX_DEPTH;
      if (unresolved) {
        incomplete = true;
        issues.push(`${cyclic ? 'CYCLE' : 'UNRESOLVED_OWNER'}:${s.name}`);
      }
      return {
        kind: 'LEGAL',
        name: s.name,
        code: s.code,
        country: s.country,
        sharePercent: s.sharePercent,
        effectivePercent: round(effective),
        unresolved,
        children: unresolved ? [] : walk(child, effective / 100, level + 1, [...path, key]),
      };
    });
  }

  const tree = walk(root, 1, 1, [companyKey(root.country, root.code)]);

  const candidates = new Map<string, UboCandidate>();
  for (const [key, { person, percent }] of owners)
    if (percent >= thresholdPercent - 1e-9)
      candidates.set(key, {
        key,
        person,
        basis: 'OWNERSHIP',
        effectivePercent: round(percent),
        computed: true,
        declared: false,
      });

  if (candidates.size === 0 && root.manager) {
    const key = personKey(root.manager);
    candidates.set(key, {
      key,
      person: root.manager,
      basis: 'SENIOR_MANAGING_OFFICIAL',
      effectivePercent: null,
      computed: true,
      declared: false,
    });
    issues.push('NO_OWNER_AT_THRESHOLD');
  }

  for (const d of root.declaredUbos) {
    const key = personKey(d.person);
    const known = candidates.get(key);
    if (known) known.declared = true;
    else
      candidates.set(key, {
        key,
        person: d.person,
        basis: d.basis,
        effectivePercent: d.sharePercent,
        computed: false,
        declared: true,
      });
  }

  // Control cannot be derived from shares, so a declared CONTROL owner alone is not a mismatch.
  const ubos = [...candidates.values()];
  const discrepancy = ubos.some(
    (u) => (u.computed && !u.declared) || (!u.computed && u.declared && u.basis === 'OWNERSHIP'),
  );
  if (discrepancy) issues.push('DECLARED_UBOS_DIFFER');

  return { thresholdPercent, tree, ubos, depth, incomplete, discrepancy, issues };
}
