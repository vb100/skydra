import {
  InPersonVerificationInput,
  RemoteVerificationInput,
  SimulateVerificationInput,
} from '@skydra/shared';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { decrypt, encrypt } from '../auth/crypto';
import { refreshCompliance } from '../cases/cases';
import { maskPersonalCode } from '../cases/parties';
import { type TenantContext, withTenant } from '../database/tenant';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';
import type { IdentityProvider, IdentitySubject } from './identity-provider';

export type IdentityKeys = { documentNumberEncryption: Buffer };

export type IdentityVerification = {
  id: string;
  casePartyId: string;
  method: 'REMOTE' | 'IN_PERSON';
  provider: string;
  status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'FAILED';
  documentType: string | null;
  documentNumberMasked: string | null;
  documentCountry: string | null;
  documentExpiresOn: string | null;
  verifiedName: string | null;
  failureReason: string | null;
  sessionUrl: string | null;
  requestedAt: string;
  completedAt: string | null;
  completedBy: string | null;
};

/** The case party as an identity subject; must be a natural person in a visible case. */
async function subjectOf(client: PoolClient, caseId: string, casePartyId: string) {
  const { rows } = await client.query<{
    party_id: string;
    party_type: string;
    display_name: string;
    birth_date: string | null;
    citizenships: string[];
  }>(
    `SELECT p.id AS party_id, p.party_type, p.display_name,
            to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date, p.citizenships
       FROM case_parties cp JOIN parties p ON p.id = cp.party_id
      WHERE cp.id = $1 AND cp.case_id = $2 AND cp.removed_at IS NULL`,
    [casePartyId, caseId],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError('case party not found');
  if (r.party_type !== 'NATURAL')
    throw new RuleError('identity verification applies to natural persons');
  const subject: IdentitySubject = {
    name: r.display_name,
    birthDate: r.birth_date,
    countries: r.citizenships,
  };
  return { partyId: r.party_id, subject };
}

/**
 * The broker has seen the person and their identity document. Recorded as verified at once; the
 * document number is stored encrypted.
 */
export async function recordInPersonVerification(
  client: PoolClient,
  keys: IdentityKeys,
  caseId: string,
  input: InPersonVerificationInput,
): Promise<{ id: string; complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const i = InPersonVerificationInput.parse(input);
  const { partyId, subject } = await subjectOf(client, id, i.casePartyId);
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO identity_verifications
         (case_id, case_party_id, party_id, method, provider, status, document_type,
          document_number_encrypted, document_country, document_expires_on, verified_name,
          verified_birth_date)
       VALUES ($1, $2, $3, 'IN_PERSON', 'MANUAL', 'VERIFIED', $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        id,
        i.casePartyId,
        partyId,
        i.documentType,
        encrypt(keys.documentNumberEncryption, i.documentNumber.replace(/[\s-]/g, '')),
        i.documentCountry,
        i.documentExpiresOn ?? null,
        subject.name,
        subject.birthDate,
      ],
    );
    const verificationId = rows[0]!.id;
    await recordAudit(client, {
      action: 'identity.verified_in_person',
      entityType: 'case',
      entityId: id,
      after: {
        verificationId,
        casePartyId: i.casePartyId,
        documentType: i.documentType,
        documentCountry: i.documentCountry,
      },
    });
    return { id: verificationId, complianceStatus: await refreshCompliance(client, id) };
  } catch (error) {
    translateDbError(error);
  }
}

/** Starts a remote session with the provider; the result arrives later. */
export async function startRemoteVerification(
  pool: Pool,
  ctx: TenantContext,
  provider: IdentityProvider,
  caseId: string,
  input: z.input<typeof RemoteVerificationInput>,
): Promise<{ id: string; sessionUrl: string | null }> {
  const id = z.uuid().parse(caseId);
  const { casePartyId } = RemoteVerificationInput.parse(input);
  const { partyId, subject } = await withTenant(pool, ctx, (c) => subjectOf(c, id, casePartyId));
  // The provider is called outside any transaction (a network call for a real provider).
  const session = await provider.start(subject);

  return withTenant(pool, ctx, async (client) => {
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO identity_verifications
           (case_id, case_party_id, party_id, method, provider, status, provider_reference,
            details)
         VALUES ($1, $2, $3, 'REMOTE', $4, 'PENDING', $5, $6)
         RETURNING id`,
        [
          id,
          casePartyId,
          partyId,
          provider.mode,
          session.reference,
          JSON.stringify({ sessionUrl: session.sessionUrl }),
        ],
      );
      const verificationId = rows[0]!.id;
      await recordAudit(client, {
        action: 'identity.remote_started',
        entityType: 'case',
        entityId: id,
        after: { verificationId, casePartyId, provider: provider.mode },
      });
      return { id: verificationId, sessionUrl: session.sessionUrl };
    } catch (error) {
      translateDbError(error);
    }
  });
}

/** MOCK only: ends a pending remote session with the chosen outcome. */
export async function simulateRemoteVerification(
  client: PoolClient,
  provider: IdentityProvider,
  caseId: string,
  verificationId: string,
  input: z.input<typeof SimulateVerificationInput>,
): Promise<{ complianceStatus: string }> {
  if (provider.mode !== 'MOCK' || !provider.simulate)
    throw new RuleError('results can only be simulated with the MOCK provider');
  const id = z.uuid().parse(caseId);
  const vId = z.uuid().parse(verificationId);
  const { outcome } = SimulateVerificationInput.parse(input);

  const { rows } = await client.query<{ case_party_id: string; status: string; provider: string }>(
    `SELECT case_party_id, status, provider FROM identity_verifications
      WHERE id = $1 AND case_id = $2 AND method = 'REMOTE'`,
    [vId, id],
  );
  const v = rows[0];
  if (!v) throw new NotFoundError('identity verification not found');
  if (v.status !== 'PENDING' || v.provider !== 'MOCK')
    throw new RuleError('this verification is not a pending simulated session');

  const { subject } = await subjectOf(client, id, v.case_party_id);
  const r = provider.simulate(subject, outcome);
  try {
    await client.query(
      `UPDATE identity_verifications
          SET status = $2, verified_name = $3, verified_birth_date = $4, document_type = $5,
              document_country = $6, document_expires_on = $7, failure_reason = $8,
              details = details || $9::jsonb
        WHERE id = $1`,
      [
        vId,
        r.status,
        r.verifiedName,
        r.verifiedBirthDate,
        r.documentType,
        r.documentCountry,
        r.documentExpiresOn,
        r.failureReason,
        JSON.stringify(r.details),
      ],
    );
  } catch (error) {
    translateDbError(error);
  }
  await recordAudit(client, {
    action: 'identity.remote_completed',
    entityType: 'case',
    entityId: id,
    after: { verificationId: vId, casePartyId: v.case_party_id, status: r.status },
  });
  return { complianceStatus: await refreshCompliance(client, id) };
}

export async function listIdentityVerifications(
  client: PoolClient,
  keys: IdentityKeys,
  caseId: string,
): Promise<IdentityVerification[]> {
  const { rows } = await client.query<
    Omit<IdentityVerification, 'documentNumberMasked' | 'sessionUrl'> & {
      document_number_encrypted: string | null;
      details: { sessionUrl?: string | null };
    }
  >(
    `SELECT id, case_party_id AS "casePartyId", method, provider, status,
            document_type AS "documentType", document_number_encrypted,
            document_country AS "documentCountry",
            to_char(document_expires_on, 'YYYY-MM-DD') AS "documentExpiresOn",
            verified_name AS "verifiedName", failure_reason AS "failureReason", details,
            requested_at AS "requestedAt", completed_at AS "completedAt",
            completed_by AS "completedBy"
       FROM identity_verifications WHERE case_id = $1
      ORDER BY requested_at DESC, id`,
    [z.uuid().parse(caseId)],
  );
  return rows.map(({ document_number_encrypted, details, ...v }) => ({
    ...v,
    documentNumberMasked: document_number_encrypted
      ? maskPersonalCode(decrypt(keys.documentNumberEncryption, document_number_encrypted))
      : null,
    sessionUrl: details.sessionUrl ?? null,
  }));
}
