import { ReopenCaseInput } from '@skydra/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import type { PartyKeys } from '../cases/parties';
import { getCase, refreshCompliance } from '../cases/cases';
import { NotFoundError, translateDbError } from '../domain-errors';

export type CaseRevision = {
  id: string;
  reason: string;
  openedBy: string;
  openedByName: string;
  openedAt: string;
  closedAt: string | null;
  closedByDecision: string | null;
  snapshot: Record<string, unknown>;
};

/**
 * Reopens a completed case to change it (client answer Q26). The state it leaves is kept with
 * the reason; the case then needs a new final decision, which closes the reopening. Only a
 * completed case can be reopened, one reopening at a time (the database checks both).
 */
export async function reopenCase(
  client: PoolClient,
  keys: PartyKeys,
  caseId: string,
  input: ReopenCaseInput,
): Promise<{ id: string; complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const { reason } = ReopenCaseInput.parse(input);
  const c = await getCase(client, keys, id);
  const { rows: last } = await client.query<{
    decision: string;
    decided_at: string;
    final_level: string | null;
    next_review_on: string | null;
  }>(
    `SELECT d.decision, d.decided_at,
            (SELECT r.final_level FROM risk_assessments r WHERE r.case_id = $1
              ORDER BY r.assessed_at DESC LIMIT 1) AS final_level,
            to_char(d.next_review_on, 'YYYY-MM-DD') AS next_review_on
       FROM case_decisions d WHERE d.case_id = $1 ORDER BY d.decided_at DESC LIMIT 1`,
    [id],
  );
  // What the case was when reopened, as the broker saw it (personal codes masked).
  const snapshot = {
    complianceStatus: c.complianceStatus,
    stage: c.stage,
    riskLevel: last[0]?.final_level ?? null,
    decision: last[0]
      ? {
          decision: last[0].decision,
          decidedAt: last[0].decided_at,
          nextReviewOn: last[0].next_review_on,
        }
      : null,
    transaction: {
      type: c.transactionType,
      value: c.transactionValue,
      monthlyRent: c.monthlyRent,
      paymentMethod: c.paymentMethod,
      propertyAddress: c.propertyAddress,
    },
    parties: c.parties.map((p) => ({
      role: p.role,
      name: p.party.displayName,
      code: p.party.personalCodeMasked ?? p.party.companyCode,
    })),
  };
  let revisionId: string;
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO case_revisions (case_id, reason, snapshot) VALUES ($1, $2, $3) RETURNING id`,
      [id, reason, JSON.stringify(snapshot)],
    );
    revisionId = rows[0]!.id;
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      translateDbError(error, 'the case is already reopened');
    translateDbError(error);
  }
  await recordAudit(client, {
    action: 'case.reopened',
    entityType: 'case',
    entityId: id,
    before: { complianceStatus: c.complianceStatus },
    after: { revisionId, reason },
  });
  return { id: revisionId, complianceStatus: await refreshCompliance(client, id) };
}

export async function listRevisions(client: PoolClient, caseId: string): Promise<CaseRevision[]> {
  const id = z.uuid().parse(caseId);
  const { rowCount } = await client.query('SELECT 1 FROM cases WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError('case not found');
  const { rows } = await client.query<CaseRevision>(
    `SELECT v.id, v.reason, v.opened_by AS "openedBy", u.full_name AS "openedByName",
            v.opened_at AS "openedAt", v.closed_at AS "closedAt",
            v.closed_by_decision AS "closedByDecision", v.snapshot
       FROM case_revisions v JOIN users u ON u.id = v.opened_by
      WHERE v.case_id = $1 ORDER BY v.opened_at DESC`,
    [id],
  );
  return rows;
}
