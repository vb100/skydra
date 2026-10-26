import { PartyInput } from '@skydra/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { decrypt, encrypt, personalCodeIndex } from '../auth/crypto';
import { NotFoundError, translateDbError } from '../domain-errors';

export type PartyKeys = { personalCodeEncryption: Buffer; personalCodeIndex: Buffer };

export type Party = {
  id: string;
  partyType: 'NATURAL' | 'LEGAL';
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null;
  /** Only the last digits are ever returned by the API. */
  personalCodeMasked: string | null;
  citizenships: string[];
  residenceCountry: string | null;
  companyName: string | null;
  companyCode: string | null;
  legalForm: string | null;
  registrationCountry: string | null;
  registeredAddress: string | null;
};

const SELECT = `
  SELECT id, party_type AS "partyType", display_name AS "displayName",
         first_name AS "firstName", last_name AS "lastName",
         to_char(birth_date, 'YYYY-MM-DD') AS "birthDate",
         personal_code_encrypted, citizenships, residence_country AS "residenceCountry",
         company_name AS "companyName", company_code AS "companyCode", legal_form AS "legalForm",
         registration_country AS "registrationCountry", registered_address AS "registeredAddress"
    FROM parties`;

type Row = Omit<Party, 'personalCodeMasked'> & { personal_code_encrypted: string | null };

export function maskPersonalCode(code: string): string {
  return `${'•'.repeat(Math.max(code.length - 4, 0))}${code.slice(-4)}`;
}

function toParty(keys: PartyKeys, { personal_code_encrypted, ...rest }: Row): Party {
  return {
    ...rest,
    personalCodeMasked: personal_code_encrypted
      ? maskPersonalCode(decrypt(keys.personalCodeEncryption, personal_code_encrypted))
      : null,
  };
}

const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

/** Parties visible to the member (row-level security decides), optionally filtered. */
export async function searchParties(
  client: PoolClient,
  keys: PartyKeys,
  organizationId: string,
  query: string,
): Promise<Party[]> {
  const q = z.string().trim().max(100).parse(query);
  if (q.length < 2) return [];
  // A query that looks like a code matches the personal code exactly (via the blind index) or the
  // company code; otherwise it is a name search.
  const index = personalCodeIndex(keys.personalCodeIndex, organizationId, q);
  const { rows } = await client.query<Row>(
    `${SELECT}
      WHERE display_name ILIKE '%' || $1 || '%' OR personal_code_index = $2 OR company_code = $3
      ORDER BY display_name LIMIT 20`,
    [q.replace(/[\\%_]/g, (c) => `\\${c}`), index, q],
  );
  return rows.map((r) => toParty(keys, r));
}

export async function getParty(client: PoolClient, keys: PartyKeys, id: string): Promise<Party> {
  const { rows } = await client.query<Row>(`${SELECT} WHERE id = $1`, [z.uuid().parse(id)]);
  if (!rows[0]) throw new NotFoundError('party not found');
  return toParty(keys, rows[0]);
}

/**
 * Returns the id of the organization's party with the same personal or company code, or creates
 * a new one. An existing party keeps its data: details are corrected on the party itself.
 */
export async function findOrCreateParty(
  client: PoolClient,
  keys: PartyKeys,
  organizationId: string,
  input: PartyInput,
): Promise<{ partyId: string; created: boolean }> {
  const p = PartyInput.parse(input);
  const code = p.partyType === 'NATURAL' && p.personalCode ? normalizeCode(p.personalCode) : null;
  const index = code ? personalCodeIndex(keys.personalCodeIndex, organizationId, code) : null;
  const companyCode = p.partyType === 'LEGAL' ? (p.companyCode ?? null) : null;

  if (index || companyCode) {
    const { rows } = await client.query<{ id: string | null }>(
      'SELECT app.find_party($1, $2, $3) AS id',
      [index, p.partyType === 'LEGAL' ? p.registrationCountry : null, companyCode],
    );
    if (rows[0]?.id) return { partyId: rows[0].id, created: false };
  }

  const values: Record<string, string | string[] | null> =
    p.partyType === 'NATURAL'
      ? {
          displayName: `${p.firstName} ${p.lastName}`,
          firstName: p.firstName,
          lastName: p.lastName,
          birthDate: p.birthDate ?? null,
          encrypted: code ? encrypt(keys.personalCodeEncryption, code) : null,
          citizenships: [...new Set(p.citizenships)],
          residenceCountry: p.residenceCountry ?? null,
        }
      : {
          displayName: p.companyName,
          companyName: p.companyName,
          companyCode,
          legalForm: p.legalForm ?? null,
          registrationCountry: p.registrationCountry,
          registeredAddress: p.registeredAddress ?? null,
        };
  const displayName = values.displayName as string;

  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO parties (party_type, display_name, first_name, last_name, birth_date,
                            personal_code_encrypted, personal_code_index, citizenships,
                            residence_country, company_name, company_code, legal_form,
                            registration_country, registered_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, '{}'::text[]), $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        p.partyType,
        displayName,
        values.firstName ?? null,
        values.lastName ?? null,
        values.birthDate ?? null,
        values.encrypted ?? null,
        index,
        values.citizenships ?? null,
        values.residenceCountry ?? null,
        values.companyName ?? null,
        values.companyCode ?? null,
        values.legalForm ?? null,
        values.registrationCountry ?? null,
        values.registeredAddress ?? null,
      ],
    );
    const partyId = rows[0]!.id;
    // The personal code never enters the audit trail, only the fact that one was recorded.
    await recordAudit(client, {
      action: 'party.created',
      entityType: 'party',
      entityId: partyId,
      after: {
        partyType: p.partyType,
        displayName,
        hasPersonalCode: code !== null,
        companyCode,
      },
    });
    return { partyId, created: true };
  } catch (error) {
    translateDbError(error, 'this party is already registered in the organization');
  }
}
