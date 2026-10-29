import { ResolveOwnershipInput } from '@skydra/shared';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { decrypt, encrypt, personalCodeIndex } from '../auth/crypto';
import { refreshCompliance } from '../cases/cases';
import { findOrCreateParty, maskPersonalCode, type PartyKeys } from '../cases/parties';
import { type TenantContext, withTenant } from '../database/tenant';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';
import { analyseOwnership, type OwnershipAnalysis, type UboCandidate } from './analysis';
import type { CompanyRecord, RegistryPerson, RegistryProvider } from './registry-provider';

/** At most this many companies are fetched for one ownership chain. */
const MAX_COMPANIES = 20;

/** A registry person as stored and returned: the personal code only encrypted and masked. */
type StoredPerson = Omit<RegistryPerson, 'personalCode'> & {
  personalCodeMasked: string | null;
  personalCodeEncrypted: string | null;
};

type StoredUbo = Omit<UboCandidate, 'person' | 'key'> & { key: string; person: StoredPerson };

export type OwnershipView = {
  snapshotId: string;
  casePartyId: string;
  provider: string;
  company: Omit<CompanyRecord, 'manager' | 'shareholders' | 'declaredUbos'> & {
    manager: PublicPerson | null;
  };
  analysis: Pick<OwnershipAnalysis, 'thresholdPercent' | 'tree' | 'depth' | 'issues'>;
  ubos: (Omit<StoredUbo, 'person'> & { person: PublicPerson; linked: boolean })[];
  incomplete: boolean;
  discrepancy: boolean;
  resolution: {
    resolution: string;
    notes: string;
    evidence: string;
    resolvedByName: string;
    resolvedAt: string;
  } | null;
  fetchedAt: string;
};

type PublicPerson = Omit<StoredPerson, 'personalCodeEncrypted'>;

/**
 * Replaces every personal code in registry data by its encrypted value and a mask, so that the
 * stored JSON never holds a code in clear.
 */
function protect<T>(value: T, key: Buffer): T {
  if (Array.isArray(value)) return value.map((v) => protect(v, key)) as T;
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if ('personalCode' in (value as object) && 'lastName' in (value as object)) {
    const { personalCode, ...rest } = value as unknown as RegistryPerson;
    const code = personalCode ? personalCode.replace(/[\s-]/g, '').toUpperCase() : null;
    return {
      ...rest,
      personalCodeMasked: code ? maskPersonalCode(code) : null,
      personalCodeEncrypted: code ? encrypt(key, code) : null,
    } as T;
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, protect(v, key)])) as T;
}

/** Drops encrypted values before data leaves the API. */
function publicView<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicView) as T;
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'personalCodeEncrypted')
      .map(([k, v]) => [k, publicView(v)]),
  ) as T;
}

async function legalParty(client: PoolClient, caseId: string, casePartyId: string) {
  const { rows } = await client.query<{
    party_id: string;
    party_type: string;
    cdd_scope: string;
    company_code: string | null;
    registration_country: string | null;
  }>(
    `SELECT p.id AS party_id, p.party_type, cp.cdd_scope, p.company_code, p.registration_country
       FROM case_parties cp JOIN parties p ON p.id = cp.party_id
      WHERE cp.id = $1 AND cp.case_id = $2 AND cp.removed_at IS NULL`,
    [casePartyId, caseId],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError('case party not found');
  if (r.party_type !== 'LEGAL') throw new RuleError('registry data applies to legal entities');
  if (!r.company_code || !r.registration_country)
    throw new RuleError('enter the company code and registration country first');
  return { ...r, company_code: r.company_code, registration_country: r.registration_country };
}

/**
 * Fetches the company and, following legal shareholders, its ownership chain from the registry
 * provider (outside any transaction), analyses it and stores the result as evidence.
 */
export async function fetchOwnership(
  pool: Pool,
  ctx: TenantContext,
  keys: PartyKeys,
  provider: RegistryProvider,
  caseId: string,
  casePartyId: string,
): Promise<{ snapshotId: string; complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const cpId = z.uuid().parse(casePartyId);
  const { party, threshold } = await withTenant(pool, ctx, async (c) => {
    const party = await legalParty(c, id, cpId);
    const { rows } = await c.query<{ id: string; threshold_percent: string }>(
      `SELECT id, threshold_percent FROM ownership_rule_sets
        WHERE code = 'LT-UBO-01' AND valid_from <= now() ORDER BY valid_from DESC LIMIT 1`,
    );
    if (!rows[0]) throw new Error('no ownership rule set in force');
    return { party, threshold: rows[0] };
  });

  const root = await provider.company(party.registration_country, party.company_code);
  if (!root) throw new RuleError('the company was not found in the registries');
  const records = new Map<string, CompanyRecord>([[`${root.country}:${root.code}`, root]]);
  const queue = [root];
  while (queue.length > 0 && records.size < MAX_COMPANIES) {
    for (const s of queue.shift()!.shareholders) {
      if (s.kind !== 'LEGAL') continue;
      const key = `${s.country.toUpperCase()}:${s.code}`;
      if (records.has(key)) continue;
      const record = await provider.company(s.country, s.code);
      if (record) {
        records.set(key, record);
        queue.push(record);
      }
    }
  }
  const analysis = analyseOwnership(root, records, Number(threshold.threshold_percent));

  // The identity key of each UBO is stored only as a keyed hash bound to the organization.
  const ubos: StoredUbo[] = analysis.ubos.map((u) => ({
    ...u,
    key: personalCodeIndex(keys.personalCodeIndex, ctx.organizationId, u.key),
    person: protect(u.person, keys.personalCodeEncryption) as unknown as StoredPerson,
  }));

  return withTenant(pool, ctx, async (client) => {
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ownership_snapshots
           (case_id, case_party_id, party_id, provider, rule_set_id, company, records, analysis,
            ubos, depth, incomplete, discrepancy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          id,
          cpId,
          party.party_id,
          provider.mode,
          threshold.id,
          JSON.stringify(protect(root, keys.personalCodeEncryption)),
          JSON.stringify(protect([...records.values()], keys.personalCodeEncryption)),
          JSON.stringify({
            thresholdPercent: analysis.thresholdPercent,
            tree: analysis.tree,
            depth: analysis.depth,
            issues: analysis.issues,
          }),
          JSON.stringify(ubos),
          analysis.depth,
          analysis.incomplete,
          analysis.discrepancy,
        ],
      );
      const snapshotId = rows[0]!.id;
      await recordAudit(client, {
        action: 'ownership.fetched',
        entityType: 'case',
        entityId: id,
        after: {
          snapshotId,
          casePartyId: cpId,
          provider: provider.mode,
          references: root.references,
          uboCount: ubos.length,
          incomplete: analysis.incomplete,
          discrepancy: analysis.discrepancy,
          issues: analysis.issues,
        },
      });
      return { snapshotId, complianceStatus: await refreshCompliance(client, id) };
    } catch (error) {
      translateDbError(error);
    }
  });
}

type SnapshotRow = {
  id: string;
  case_party_id: string;
  provider: string;
  company: CompanyRecord & { manager: StoredPerson | null };
  analysis: OwnershipView['analysis'];
  ubos: StoredUbo[];
  incomplete: boolean;
  discrepancy: boolean;
  fetched_at: string;
};

async function latestSnapshots(client: PoolClient, caseId: string): Promise<SnapshotRow[]> {
  const { rows } = await client.query<SnapshotRow>(
    `SELECT DISTINCT ON (o.case_party_id) o.id, o.case_party_id, o.provider, o.company,
            o.analysis, o.ubos, o.incomplete, o.discrepancy, o.fetched_at
       FROM ownership_snapshots o JOIN case_parties cp ON cp.id = o.case_party_id
      WHERE o.case_id = $1 AND cp.removed_at IS NULL
      ORDER BY o.case_party_id, o.fetched_at DESC`,
    [caseId],
  );
  return rows;
}

/** The latest registry data of each legal entity in the case, with UBO link status. */
export async function listOwnership(client: PoolClient, caseId: string): Promise<OwnershipView[]> {
  const id = z.uuid().parse(caseId);
  const snapshots = await latestSnapshots(client, id);
  const { rows: links } = await client.query<{ beneficial_owner_of: string; ubo_key: string }>(
    `SELECT beneficial_owner_of, ubo_key FROM case_parties
      WHERE case_id = $1 AND removed_at IS NULL AND beneficial_owner_of IS NOT NULL`,
    [id],
  );
  const { rows: resolutions } = await client.query<{
    snapshot_id: string;
    resolution: string;
    notes: string;
    evidence: string;
    resolved_by_name: string;
    resolved_at: string;
  }>(
    `SELECT r.snapshot_id, r.resolution, r.notes, r.evidence, u.full_name AS resolved_by_name,
            r.resolved_at
       FROM ownership_resolutions r JOIN users u ON u.id = r.resolved_by
      WHERE r.case_id = $1`,
    [id],
  );

  return snapshots.map((s) => {
    const r = resolutions.find((x) => x.snapshot_id === s.id);
    // Shareholders and declared owners are shown through the analysis, not repeated here.
    const { code, country, name, legalForm, address, manager, references } = s.company;
    const company = { code, country, name, legalForm, address, references };
    return publicView({
      snapshotId: s.id,
      casePartyId: s.case_party_id,
      provider: s.provider,
      company: { ...company, manager },
      analysis: s.analysis,
      ubos: s.ubos.map((u) => ({
        ...u,
        linked: links.some((l) => l.beneficial_owner_of === s.case_party_id && l.ubo_key === u.key),
      })),
      incomplete: s.incomplete,
      discrepancy: s.discrepancy,
      resolution: r
        ? {
            resolution: r.resolution,
            notes: r.notes,
            evidence: r.evidence,
            resolvedByName: r.resolved_by_name,
            resolvedAt: r.resolved_at,
          }
        : null,
      fetchedAt: s.fetched_at,
    });
  });
}

async function latestFor(client: PoolClient, caseId: string, snapshotId: string) {
  const id = z.uuid().parse(caseId);
  const sId = z.uuid().parse(snapshotId);
  const snapshot = (await latestSnapshots(client, id)).find((s) => s.id === sId);
  if (!snapshot) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM ownership_snapshots WHERE id = $1 AND case_id = $2',
      [sId, id],
    );
    if (rowCount) throw new RuleError('newer registry data exists; use the latest');
    throw new NotFoundError('registry data not found');
  }
  return { id, snapshot };
}

/**
 * Adds every identified beneficial owner not yet linked as a party of the case (role
 * BENEFICIAL_OWNER), reusing an existing party with the same personal code. They are then
 * screened like any other party.
 */
export async function linkBeneficialOwners(
  client: PoolClient,
  keys: PartyKeys,
  organizationId: string,
  caseId: string,
  snapshotId: string,
): Promise<{ linked: number; complianceStatus: string }> {
  const { id, snapshot } = await latestFor(client, caseId, snapshotId);
  const { rows: existing } = await client.query<{ ubo_key: string }>(
    `SELECT ubo_key FROM case_parties
      WHERE beneficial_owner_of = $1 AND removed_at IS NULL`,
    [snapshot.case_party_id],
  );
  let linked = 0;
  for (const u of snapshot.ubos) {
    if (existing.some((e) => e.ubo_key === u.key)) continue;
    const p = u.person;
    const { partyId } = await findOrCreateParty(client, keys, organizationId, {
      partyType: 'NATURAL',
      firstName: p.firstName,
      lastName: p.lastName,
      birthDate: p.birthDate,
      personalCode: p.personalCodeEncrypted
        ? decrypt(keys.personalCodeEncryption, p.personalCodeEncrypted)
        : null,
      citizenships: p.citizenship ? [p.citizenship] : [],
      residenceCountry: null,
    });
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO case_parties (case_id, party_id, role, is_our_client, beneficial_owner_of,
                                   ubo_key)
         VALUES ($1, $2, 'BENEFICIAL_OWNER', false, $3, $4)
         RETURNING id`,
        [id, partyId, snapshot.case_party_id, u.key],
      );
      await recordAudit(client, {
        action: 'case_party.added',
        entityType: 'case',
        entityId: id,
        after: {
          casePartyId: rows[0]!.id,
          partyId,
          role: 'BENEFICIAL_OWNER',
          beneficialOwnerOf: snapshot.case_party_id,
          basis: u.basis,
          effectivePercent: u.effectivePercent,
          snapshotId: snapshot.id,
        },
      });
      linked += 1;
    } catch (error) {
      translateDbError(error, 'this person is already linked as a beneficial owner');
    }
  }
  return { linked, complianceStatus: await refreshCompliance(client, id) };
}

/** Records how a UBO discrepancy or an incomplete chain was resolved, with evidence. */
export async function resolveOwnership(
  client: PoolClient,
  caseId: string,
  snapshotId: string,
  input: ResolveOwnershipInput,
): Promise<{ complianceStatus: string }> {
  const { id, snapshot } = await latestFor(client, caseId, snapshotId);
  const i = ResolveOwnershipInput.parse(input);
  try {
    await client.query(
      `INSERT INTO ownership_resolutions (case_id, snapshot_id, resolution, notes, evidence)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, snapshot.id, i.resolution, i.notes, i.evidence],
    );
  } catch (error) {
    translateDbError(error, 'this discrepancy has already been resolved');
  }
  await recordAudit(client, {
    action: 'ownership.resolved',
    entityType: 'case',
    entityId: id,
    after: { snapshotId: snapshot.id, ...i },
  });
  return { complianceStatus: await refreshCompliance(client, id) };
}
