import {
  ChecklistItem,
  DecideApprovalInput,
  EscalateInput,
  RequestApprovalInput,
  ResolveEscalationInput,
} from '@skydra/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { refreshCompliance } from '../cases/cases';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';

export type ChecklistEntry = { casePartyId: string | null; item: ChecklistItem; ok: boolean };

export type Approval = {
  id: string;
  reason: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED';
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionJustification: string | null;
};

export type Escalation = {
  id: string;
  reason: string;
  status: 'OPEN' | 'CLEARED' | 'REPORTED';
  requestedBy: string;
  requestedByName: string;
  requestedAt: string;
  resolvedBy: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
};

const ORDER = ChecklistItem.options;

/** What the case still needs (app.case_checklist), case-level items first. */
export async function getChecklist(client: PoolClient, caseId: string): Promise<ChecklistEntry[]> {
  const id = z.uuid().parse(caseId);
  const { rowCount } = await client.query('SELECT 1 FROM cases WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError('case not found');
  const { rows } = await client.query<{ case_party_id: string | null; item: string; ok: boolean }>(
    'SELECT case_party_id, item, ok FROM app.case_checklist($1)',
    [id],
  );
  return rows
    .map((r) => ({ casePartyId: r.case_party_id, item: ChecklistItem.parse(r.item), ok: r.ok }))
    .sort(
      (a, b) =>
        ORDER.indexOf(a.item) - ORDER.indexOf(b.item) ||
        String(a.casePartyId).localeCompare(String(b.casePartyId)),
    );
}

async function failing(client: PoolClient, caseId: string): Promise<Set<ChecklistItem>> {
  return new Set((await getChecklist(client, caseId)).filter((e) => !e.ok).map((e) => e.item));
}

/** Asks for approval to proceed after a confirmed PEP or adverse-media match. */
export async function requestApproval(
  client: PoolClient,
  caseId: string,
  input: z.input<typeof RequestApprovalInput>,
): Promise<{ id: string; complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const { reason } = RequestApprovalInput.parse(input);
  if (!(await failing(client, id)).has('EDD_APPROVED'))
    throw new RuleError('this case does not need an approval');
  try {
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO case_approvals (case_id, reason) VALUES ($1, $2) RETURNING id',
      [id, reason],
    );
    const approvalId = rows[0]!.id;
    await recordAudit(client, {
      action: 'approval.requested',
      entityType: 'case',
      entityId: id,
      after: { approvalId, reason },
    });
    return { id: approvalId, complianceStatus: await refreshCompliance(client, id) };
  } catch (error) {
    translateDbError(error, 'an approval request is already open for this case');
  }
}

export async function decideApproval(
  client: PoolClient,
  caseId: string,
  approvalId: string,
  input: z.input<typeof DecideApprovalInput>,
): Promise<{ complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const aId = z.uuid().parse(approvalId);
  const { decision, justification } = DecideApprovalInput.parse(input);
  try {
    const { rowCount } = await client.query(
      `UPDATE case_approvals SET status = $3, decision_justification = $4
        WHERE id = $1 AND case_id = $2`,
      [aId, id, decision, justification],
    );
    if (!rowCount) throw new NotFoundError('approval not found');
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    translateDbError(error);
  }
  await recordAudit(client, {
    action: 'approval.decided',
    entityType: 'case',
    entityId: id,
    after: { approvalId: aId, decision, justification },
  });
  return { complianceStatus: await refreshCompliance(client, id) };
}

/** Any case worker may raise a suspicion; the case is blocked until the AML officer resolves it. */
export async function escalate(
  client: PoolClient,
  caseId: string,
  input: z.input<typeof EscalateInput>,
): Promise<{ id: string; complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const { reason } = EscalateInput.parse(input);
  const { rowCount } = await client.query('SELECT 1 FROM cases WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError('case not found');
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO case_escalations (case_id, reason) VALUES ($1, $2) RETURNING id',
    [id, reason],
  );
  const escalationId = rows[0]!.id;
  await recordAudit(client, {
    action: 'escalation.raised',
    entityType: 'case',
    entityId: id,
    after: { escalationId, reason },
  });
  return { id: escalationId, complianceStatus: await refreshCompliance(client, id) };
}

export async function resolveEscalation(
  client: PoolClient,
  caseId: string,
  escalationId: string,
  input: z.input<typeof ResolveEscalationInput>,
): Promise<{ complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const eId = z.uuid().parse(escalationId);
  const { resolution, notes } = ResolveEscalationInput.parse(input);
  try {
    const { rowCount } = await client.query(
      `UPDATE case_escalations SET status = $3, resolution_notes = $4
        WHERE id = $1 AND case_id = $2`,
      [eId, id, resolution, notes],
    );
    if (!rowCount) throw new NotFoundError('escalation not found');
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    translateDbError(error);
  }
  await recordAudit(client, {
    action: 'escalation.resolved',
    entityType: 'case',
    entityId: id,
    after: { escalationId: eId, resolution, notes },
  });
  return { complianceStatus: await refreshCompliance(client, id) };
}

/** Approvals and escalations of a case, newest first. */
export async function listDecisions(
  client: PoolClient,
  caseId: string,
): Promise<{ approvals: Approval[]; escalations: Escalation[] }> {
  const id = z.uuid().parse(caseId);
  const { rows: approvals } = await client.query<Approval>(
    `SELECT a.id, a.reason, a.status, a.requested_by AS "requestedBy",
            r.full_name AS "requestedByName", a.requested_at AS "requestedAt",
            a.decided_by AS "decidedBy", d.full_name AS "decidedByName",
            a.decided_at AS "decidedAt", a.decision_justification AS "decisionJustification"
       FROM case_approvals a
       JOIN users r ON r.id = a.requested_by
       LEFT JOIN users d ON d.id = a.decided_by
      WHERE a.case_id = $1 ORDER BY a.requested_at DESC`,
    [id],
  );
  const { rows: escalations } = await client.query<Escalation>(
    `SELECT e.id, e.reason, e.status, e.requested_by AS "requestedBy",
            r.full_name AS "requestedByName", e.requested_at AS "requestedAt",
            e.resolved_by AS "resolvedBy", d.full_name AS "resolvedByName",
            e.resolved_at AS "resolvedAt", e.resolution_notes AS "resolutionNotes"
       FROM case_escalations e
       JOIN users r ON r.id = e.requested_by
       LEFT JOIN users d ON d.id = e.resolved_by
      WHERE e.case_id = $1 ORDER BY e.requested_at DESC`,
    [id],
  );
  return { approvals, escalations };
}
