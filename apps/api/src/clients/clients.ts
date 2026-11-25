import { type ScreeningStatus, screeningStatus, worstScreeningStatus } from '@skydra/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { decrypt } from '../auth/crypto';
import { getParty, maskPersonalCode, type Party, type PartyKeys } from '../cases/parties';
import { NotFoundError } from '../domain-errors';

/**
 * The simple clients list (client answer Q7): every person and company the member can see
 * (row-level security decides, as for cases), with what their cases add up to. The same person
 * in several cases is one client.
 */
export type ClientListItem = {
  id: string;
  partyType: 'NATURAL' | 'LEGAL';
  displayName: string;
  /** Only the last digits of a personal code; a company code in full. */
  code: string | null;
  countries: string[];
  roles: string[];
  isOurClient: boolean;
  cases: number;
  openCases: number;
  lastActivityAt: string | null;
  /** The most serious screening status among the client's cases. */
  screening: ScreeningStatus;
};

export type ClientCase = {
  casePartyId: string;
  caseId: string;
  reference: string;
  role: string;
  isOurClient: boolean;
  transactionType: string;
  propertyAddress: string;
  stage: string;
  complianceStatus: string;
  responsibleName: string;
  addedAt: string;
  removedAt: string | null;
  screening: ScreeningStatus;
};

export type ClientDocument = {
  id: string;
  caseId: string;
  reference: string;
  category: string;
  fileName: string;
  sizeBytes: number;
  uploadedByName: string;
  uploadedAt: string;
};

export type ClientDetail = {
  party: Party;
  cases: ClientCase[];
  documents: ClientDocument[];
  screening: ScreeningStatus;
};

type CheckRow = {
  case_party_id: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  matches: {
    strength: 'STRONG' | 'WEAK';
    reviewStatus: 'OPEN' | 'FALSE_POSITIVE' | 'TRUE_POSITIVE' | 'NOT_RELEVANT';
    categories: string[];
  }[];
};

/** The screening status of each case link, from its checks (newest first). */
async function statusByCaseParty(
  client: PoolClient,
  partyId: string | null,
): Promise<Map<string, ScreeningStatus>> {
  const { rows } = await client.query<CheckRow>(
    `SELECT s.case_party_id, s.status,
            coalesce(json_agg(json_build_object('strength', m.strength,
                                                'reviewStatus', m.review_status,
                                                'categories', m.categories))
                       FILTER (WHERE m.id IS NOT NULL), '[]') AS matches
       FROM screening_checks s
       JOIN case_parties cp ON cp.id = s.case_party_id
       LEFT JOIN screening_matches m ON m.check_id = s.id
      WHERE ($1::uuid IS NULL OR cp.party_id = $1)
      GROUP BY s.id
      ORDER BY s.requested_at DESC, s.id`,
    [partyId],
  );
  const byLink = new Map<string, CheckRow[]>();
  for (const r of rows) byLink.set(r.case_party_id, [...(byLink.get(r.case_party_id) ?? []), r]);
  return new Map([...byLink].map(([id, checks]) => [id, screeningStatus(checks).status]));
}

export async function listClients(client: PoolClient, keys: PartyKeys): Promise<ClientListItem[]> {
  const { rows } = await client.query<{
    id: string;
    party_type: 'NATURAL' | 'LEGAL';
    display_name: string;
    personal_code_encrypted: string | null;
    company_code: string | null;
    countries: string[];
    roles: string[] | null;
    our_client: boolean | null;
    cases: number;
    open_cases: number;
    last_activity: string | null;
    links: string[] | null;
  }>(
    `SELECT p.id, p.party_type, p.display_name, p.personal_code_encrypted, p.company_code,
            array_remove(p.citizenships || ARRAY[p.residence_country, p.registration_country], NULL)
              AS countries,
            a.roles, a.our_client, coalesce(a.cases, 0) AS cases,
            coalesce(a.open_cases, 0) AS open_cases, a.last_activity, a.links
       FROM parties p
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT cp.role ORDER BY cp.role) AS roles,
                bool_or(cp.is_our_client) AS our_client,
                count(DISTINCT cp.case_id)::int AS cases,
                count(DISTINCT cp.case_id) FILTER (
                  WHERE c.compliance_status NOT IN ('COMPLETED', 'CLOSED')
                    AND c.stage NOT IN ('COMPLETED', 'TERMINATED'))::int AS open_cases,
                max(c.updated_at) AS last_activity,
                array_agg(cp.id) AS links
           FROM case_parties cp JOIN cases c ON c.id = cp.case_id
          WHERE cp.party_id = p.id AND cp.removed_at IS NULL
       ) a ON true
      ORDER BY a.last_activity DESC NULLS LAST, p.display_name
      LIMIT 2000`,
  );
  const statuses = await statusByCaseParty(client, null);
  return rows.map((r) => ({
    id: r.id,
    partyType: r.party_type,
    displayName: r.display_name,
    code: r.personal_code_encrypted
      ? maskPersonalCode(decrypt(keys.personalCodeEncryption, r.personal_code_encrypted))
      : r.company_code,
    countries: [...new Set(r.countries)],
    roles: r.roles ?? [],
    isOurClient: r.our_client ?? false,
    cases: r.cases,
    openCases: r.open_cases,
    lastActivityAt: r.last_activity,
    screening: worstScreeningStatus(
      (r.links ?? []).map((id) => statuses.get(id) ?? 'NOT_SCREENED'),
    ),
  }));
}

/** One client: their details, every case they are part of (also earlier ones), their documents. */
export async function getClient(
  client: PoolClient,
  keys: PartyKeys,
  partyId: string,
): Promise<ClientDetail> {
  const id = z.uuid().parse(partyId);
  const party = await getParty(client, keys, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new NotFoundError('client not found');
    throw error;
  });
  const statuses = await statusByCaseParty(client, id);
  const { rows: links } = await client.query<Omit<ClientCase, 'screening'>>(
    `SELECT cp.id AS "casePartyId", c.id AS "caseId", c.reference, cp.role,
            cp.is_our_client AS "isOurClient", c.transaction_type AS "transactionType",
            c.property_address AS "propertyAddress", c.stage,
            c.compliance_status AS "complianceStatus", u.full_name AS "responsibleName",
            cp.added_at AS "addedAt", cp.removed_at AS "removedAt"
       FROM case_parties cp
       JOIN cases c ON c.id = cp.case_id
       JOIN users u ON u.id = c.responsible_user_id
      WHERE cp.party_id = $1
      ORDER BY cp.removed_at IS NOT NULL, c.updated_at DESC, cp.added_at DESC`,
    [id],
  );
  const cases = links.map((l) => ({
    ...l,
    screening: statuses.get(l.casePartyId) ?? ('NOT_SCREENED' as const),
  }));
  const { rows: documents } = await client.query<ClientDocument>(
    `SELECT d.id, d.case_id AS "caseId", c.reference, d.category, d.file_name AS "fileName",
            d.size_bytes AS "sizeBytes", u.full_name AS "uploadedByName",
            d.uploaded_at AS "uploadedAt"
       FROM case_documents d
       JOIN case_parties cp ON cp.id = d.case_party_id
       JOIN cases c ON c.id = d.case_id
       JOIN users u ON u.id = d.uploaded_by
      WHERE cp.party_id = $1
      ORDER BY d.uploaded_at DESC`,
    [id],
  );
  return {
    party,
    cases,
    documents,
    screening: worstScreeningStatus(cases.filter((c) => !c.removedAt).map((c) => c.screening)),
  };
}
