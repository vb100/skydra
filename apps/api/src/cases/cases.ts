import {
  ActivateAmlInput,
  AddCasePartyInput,
  CreateCaseInput,
  UpdateCaseInput,
  UpdateCasePartyInput,
} from '@skydra/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';
import { findOrCreateParty, getParty, type Party, type PartyKeys } from './parties';

export type CaseSummary = {
  id: string;
  reference: string;
  transactionType: string;
  propertyType: string;
  propertyAddress: string;
  stage: string;
  amlApplicability: string;
  complianceStatus: string;
  responsibleUserId: string;
  responsibleName: string;
  partyCount: number;
  updatedAt: string;
};

export type CaseDetail = CaseSummary & {
  transactionValue: string | null;
  monthlyRent: string | null;
  paymentMethod: string | null;
  paymentMethodOther: string | null;
  offerAcceptedAt: string | null;
  amlActivationReason: string | null;
  legalRegime: string;
  createdBy: string;
  createdAt: string;
  parties: CaseParty[];
};

export type CaseParty = {
  id: string;
  role: string;
  isOurClient: boolean;
  representedByOtherBroker: boolean;
  cddScope: string;
  reliance: unknown;
  cddStatus: string;
  kyc: unknown;
  addedAt: string;
  party: Party;
};

/** Who is acting and whether they may assign cases to others (`case.assign`). */
export type CaseActor = { userId: string; organizationId: string; canAssign: boolean };

const SUMMARY = `
  SELECT c.id, c.reference, c.transaction_type AS "transactionType",
         c.property_type AS "propertyType", c.property_address AS "propertyAddress", c.stage,
         c.aml_applicability AS "amlApplicability", c.compliance_status AS "complianceStatus",
         c.responsible_user_id AS "responsibleUserId", u.full_name AS "responsibleName",
         (SELECT count(*)::int FROM case_parties cp
           WHERE cp.case_id = c.id AND cp.removed_at IS NULL) AS "partyCount",
         c.updated_at AS "updatedAt"`;

const DETAIL = `${SUMMARY},
         c.transaction_value::text AS "transactionValue", c.monthly_rent::text AS "monthlyRent",
         c.payment_method AS "paymentMethod", c.payment_method_other AS "paymentMethodOther",
         c.offer_accepted_at AS "offerAcceptedAt", c.aml_activation_reason AS "amlActivationReason",
         c.legal_regime AS "legalRegime", c.created_by AS "createdBy", c.created_at AS "createdAt"`;

// Cases are filtered by row-level security: the member sees only what case_access() allows.
const FROM = 'FROM cases c JOIN users u ON u.id = c.responsible_user_id';

/** Case fields compared in audit events; values the database derives are included. */
const AUDITED = `SELECT transaction_type, property_type, property_address, transaction_value,
                        monthly_rent, payment_method, payment_method_other, stage,
                        offer_accepted_at, aml_applicability, aml_activation_reason,
                        responsible_user_id
                   FROM cases WHERE id = $1`;

export async function listCases(client: PoolClient): Promise<CaseSummary[]> {
  const { rows } = await client.query<CaseSummary>(
    `${SUMMARY} ${FROM} ORDER BY c.updated_at DESC LIMIT 500`,
  );
  return rows;
}

/**
 * Recomputes the derived compliance status of a case (app.refresh_case_compliance, migration
 * 0007). Called after every change that can affect it.
 */
export async function refreshCompliance(client: PoolClient, caseId: string): Promise<string> {
  const { rows } = await client.query<{ status: string }>(
    'SELECT app.refresh_case_compliance($1) AS status',
    [caseId],
  );
  return rows[0]!.status;
}

async function audited(client: PoolClient, id: string) {
  const { rows } = await client.query(AUDITED, [id]);
  if (!rows[0]) throw new NotFoundError('case not found');
  return rows[0] as Record<string, unknown>;
}

export async function getCase(
  client: PoolClient,
  keys: PartyKeys,
  caseId: string,
): Promise<CaseDetail> {
  const id = z.uuid().parse(caseId);
  const { rows } = await client.query<Omit<CaseDetail, 'parties'>>(
    `${DETAIL} ${FROM} WHERE c.id = $1`,
    [id],
  );
  const found = rows[0];
  if (!found) throw new NotFoundError('case not found');

  const { rows: links } = await client.query<Omit<CaseParty, 'party'> & { partyId: string }>(
    `SELECT id, party_id AS "partyId", role, is_our_client AS "isOurClient",
            represented_by_other_broker AS "representedByOtherBroker", cdd_scope AS "cddScope",
            reliance, cdd_status AS "cddStatus", kyc, added_at AS "addedAt"
       FROM case_parties WHERE case_id = $1 AND removed_at IS NULL ORDER BY added_at`,
    [id],
  );
  const parties: CaseParty[] = [];
  for (const { partyId, ...link } of links)
    parties.push({ ...link, party: await getParty(client, keys, partyId) });
  return { ...found, parties };
}

export async function createCase(
  client: PoolClient,
  actor: CaseActor,
  input: CreateCaseInput,
): Promise<{ id: string; reference: string }> {
  const c = CreateCaseInput.parse(input);
  const responsible = c.responsibleUserId ?? actor.userId;
  if (responsible !== actor.userId && !actor.canAssign)
    throw new RuleError('you cannot assign a case to another member');

  try {
    const { rows } = await client.query<{ id: string; reference: string }>(
      `INSERT INTO cases (transaction_type, property_type, property_address, transaction_value,
                          monthly_rent, payment_method, payment_method_other, responsible_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, reference`,
      [
        c.transactionType,
        c.propertyType,
        c.propertyAddress,
        c.transactionType === 'SALE' ? c.transactionValue : null,
        c.transactionType === 'RENT' ? c.monthlyRent : null,
        c.paymentMethod ?? null,
        c.paymentMethod === 'OTHER' ? c.paymentMethodOther : null,
        responsible,
      ],
    );
    const created = rows[0]!;
    await recordAudit(client, {
      action: 'case.created',
      entityType: 'case',
      entityId: created.id,
      after: { reference: created.reference, ...(await audited(client, created.id)) },
    });
    return created;
  } catch (error) {
    translateDbError(error);
  }
}

export async function updateCase(
  client: PoolClient,
  actor: CaseActor,
  caseId: string,
  input: UpdateCaseInput,
): Promise<void> {
  const id = z.uuid().parse(caseId);
  const u = UpdateCaseInput.parse(input);
  const before = await audited(client, id);

  if (
    u.responsibleUserId !== undefined &&
    u.responsibleUserId !== before.responsible_user_id &&
    !actor.canAssign
  )
    throw new RuleError('you cannot assign a case to another member');

  // The final values are computed here and written in full; switching between sale and letting
  // clears the amount that no longer applies.
  const pick = <T>(value: T | undefined, current: unknown) =>
    value === undefined ? current : value;
  const type = pick(u.transactionType, before.transaction_type);
  const method = pick(u.paymentMethod, before.payment_method);
  const stage = pick(u.stage, before.stage);
  const offerAcceptedAt =
    u.offerAcceptedAt !== undefined
      ? u.offerAcceptedAt
      : (before.offer_accepted_at ?? (stage === 'OFFER_ACCEPTED' ? new Date() : null));
  try {
    await client.query(
      `UPDATE cases SET transaction_type = $2, property_type = $3, property_address = $4,
                        transaction_value = $5, monthly_rent = $6, payment_method = $7,
                        payment_method_other = $8, stage = $9, offer_accepted_at = $10,
                        responsible_user_id = $11
        WHERE id = $1`,
      [
        id,
        type,
        pick(u.propertyType, before.property_type),
        pick(u.propertyAddress, before.property_address),
        type === 'SALE' ? pick(u.transactionValue, before.transaction_value) : null,
        type === 'RENT' ? pick(u.monthlyRent, before.monthly_rent) : null,
        method,
        method === 'OTHER' ? pick(u.paymentMethodOther, before.payment_method_other) : null,
        stage,
        offerAcceptedAt,
        pick(u.responsibleUserId, before.responsible_user_id),
      ],
    );
  } catch (error) {
    // 23514: a check constraint, e.g. a sale without a value after switching the type.
    if ((error as { code?: string }).code === '23514')
      throw new RuleError('the case data is incomplete for this transaction type');
    translateDbError(error);
  }

  const after = await audited(client, id);
  await recordAudit(client, {
    action: 'case.updated',
    entityType: 'case',
    entityId: id,
    ...changes(before, after),
  });
  await refreshCompliance(client, id);
}

/** Only the fields that changed, so the audit trail stays readable. */
function changes(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}

/**
 * Applies AML procedures to a letting below the threshold, e.g. when the broker sees risk
 * indicators. The decision is final and recorded with its reason.
 */
export async function activateAml(
  client: PoolClient,
  caseId: string,
  input: z.input<typeof ActivateAmlInput>,
): Promise<void> {
  const id = z.uuid().parse(caseId);
  const { reason } = ActivateAmlInput.parse(input);
  const before = await audited(client, id);
  if (before.aml_applicability !== 'NOT_APPLICABLE_RENT_THRESHOLD')
    throw new RuleError('AML procedures already apply to this case');

  await client.query(
    `UPDATE cases SET aml_applicability = 'MANUALLY_ACTIVATED', aml_activation_reason = $2
      WHERE id = $1`,
    [id, reason],
  );
  await recordAudit(client, {
    action: 'case.aml_activated',
    entityType: 'case',
    entityId: id,
    before: { aml_applicability: before.aml_applicability },
    after: { aml_applicability: 'MANUALLY_ACTIVATED', aml_activation_reason: reason },
  });
  await refreshCompliance(client, id);
}

async function assertCaseVisible(client: PoolClient, caseId: string): Promise<void> {
  const { rowCount } = await client.query('SELECT 1 FROM cases WHERE id = $1', [caseId]);
  if (!rowCount) throw new NotFoundError('case not found');
}

export async function addCaseParty(
  client: PoolClient,
  keys: PartyKeys,
  actor: CaseActor,
  caseId: string,
  input: AddCasePartyInput,
): Promise<{ casePartyId: string; partyId: string }> {
  const id = z.uuid().parse(caseId);
  const i = AddCasePartyInput.parse(input);
  await assertCaseVisible(client, id);

  let partyId: string;
  if (i.partyId) {
    // An existing party must be visible to the member, which also rules out other organizations.
    partyId = (await getParty(client, keys, i.partyId)).id;
  } else {
    partyId = (await findOrCreateParty(client, keys, actor.organizationId, i.party!)).partyId;
  }

  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO case_parties (case_id, party_id, role, is_our_client,
                                 represented_by_other_broker, cdd_scope, reliance, kyc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        id,
        partyId,
        i.role,
        i.isOurClient,
        i.representedByOtherBroker,
        i.cddScope,
        i.cddScope === 'RELIANCE' ? JSON.stringify(i.reliance) : null,
        JSON.stringify(i.kyc),
      ],
    );
    const casePartyId = rows[0]!.id;
    await recordAudit(client, {
      action: 'case_party.added',
      entityType: 'case',
      entityId: id,
      after: {
        casePartyId,
        partyId,
        role: i.role,
        isOurClient: i.isOurClient,
        representedByOtherBroker: i.representedByOtherBroker,
        cddScope: i.cddScope,
      },
    });
    await refreshCompliance(client, id);
    return { casePartyId, partyId };
  } catch (error) {
    translateDbError(error, 'this party already has this role in the case');
  }
}

const LINK = `SELECT is_our_client, represented_by_other_broker, cdd_scope, reliance, cdd_status,
                     kyc
                FROM case_parties
               WHERE id = $1 AND case_id = $2 AND removed_at IS NULL`;

export async function updateCaseParty(
  client: PoolClient,
  caseId: string,
  casePartyId: string,
  input: UpdateCasePartyInput,
): Promise<void> {
  const ids = [z.uuid().parse(casePartyId), z.uuid().parse(caseId)];
  const u = UpdateCasePartyInput.parse(input);
  const { rows: before } = await client.query(LINK, ids);
  if (!before[0]) throw new NotFoundError('case party not found');

  const scope = u.cddScope ?? before[0].cdd_scope;
  const reliance = u.reliance !== undefined ? u.reliance : before[0].reliance;
  if (scope === 'RELIANCE' && !reliance) throw new RuleError('describe the reliance');

  await client.query(
    `UPDATE case_parties SET
       is_our_client = coalesce($3, is_our_client),
       represented_by_other_broker = coalesce($4, represented_by_other_broker),
       cdd_scope = $5,
       reliance = $6,
       cdd_status = coalesce($7, cdd_status),
       kyc = coalesce($8, kyc)
     WHERE id = $1 AND case_id = $2`,
    [
      ...ids,
      u.isOurClient ?? null,
      u.representedByOtherBroker ?? null,
      scope,
      scope === 'RELIANCE' ? JSON.stringify(reliance) : null,
      u.cddStatus ?? null,
      u.kyc ? JSON.stringify(u.kyc) : null,
    ],
  );
  const { rows: after } = await client.query(LINK, ids);
  await recordAudit(client, {
    action: 'case_party.updated',
    entityType: 'case',
    entityId: ids[1],
    metadata: { casePartyId: ids[0] },
    ...changes(before[0], after[0]),
  });
  await refreshCompliance(client, ids[1]!);
}

/** Removal keeps the link for the history; the party itself stays in the organization. */
export async function removeCaseParty(
  client: PoolClient,
  caseId: string,
  casePartyId: string,
): Promise<void> {
  const ids = [z.uuid().parse(casePartyId), z.uuid().parse(caseId)];
  const { rows } = await client.query<{ party_id: string; role: string }>(
    `UPDATE case_parties SET removed_at = now()
      WHERE id = $1 AND case_id = $2 AND removed_at IS NULL
      RETURNING party_id, role`,
    ids,
  );
  if (!rows[0]) throw new NotFoundError('case party not found');
  await recordAudit(client, {
    action: 'case_party.removed',
    entityType: 'case',
    entityId: ids[1],
    before: { casePartyId: ids[0], partyId: rows[0].party_id, role: rows[0].role },
  });
  await refreshCompliance(client, ids[1]!);
}

/** Active brokers and managers who can be responsible for a case. */
export async function listAssignees(
  client: PoolClient,
): Promise<{ userId: string; fullName: string }[]> {
  const { rows } = await client.query<{ userId: string; fullName: string }>(
    `SELECT u.id AS "userId", u.full_name AS "fullName"
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.status = 'ACTIVE' AND u.status = 'ACTIVE'
        AND m.roles && ARRAY['BROKER', 'MANAGER']
      ORDER BY u.full_name`,
  );
  return rows;
}
