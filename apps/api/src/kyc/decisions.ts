import {
  ChecklistItem,
  DecideApprovalInput,
  type CaseDecision,
  EscalateInput,
  RecordDecisionInput,
  RequestApprovalInput,
  ResolveEscalationInput,
} from '@skydra/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { refreshCompliance } from '../cases/cases';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';
import { type CaseRevision, listRevisions } from './revisions';

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
  const missing = await failing(client, id);
  // Confirmed sanctions stop the transaction; there is nothing an approver could approve.
  if (missing.has('NO_CONFIRMED_SANCTIONS'))
    throw new RuleError('confirmed sanctions: the transaction cannot be approved');
  // The approver decides on the final risk, so it must be assessed and current.
  if (missing.has('RISK_ASSESSED'))
    throw new RuleError('assess the risk before asking for approval');
  if (!missing.has('EDD_APPROVED')) throw new RuleError('this case does not need an approval');
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

export type FinalDecision = {
  id: string;
  decision: CaseDecision;
  justification: string;
  suspiciousIndicators: boolean;
  suspicionNotes: string | null;
  riskLevel: string | null;
  nextReviewOn: string | null;
  legalRegime: string;
  decidedBy: string;
  decidedByName: string;
  decidedAt: string;
};

/**
 * The broker's final decision (client answer Q25). The rules (what must be done before an
 * approval, approve vs. approve with enhanced measures, decline vs. terminate, suspicion reported
 * first, nothing after closing) are enforced by the database; their messages come back as rule
 * violations.
 */
export async function recordDecision(
  client: PoolClient,
  caseId: string,
  input: z.input<typeof RecordDecisionInput>,
): Promise<{ id: string; complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const d = RecordDecisionInput.parse(input);
  const { rowCount } = await client.query('SELECT 1 FROM cases WHERE id = $1', [id]);
  if (!rowCount) throw new NotFoundError('case not found');
  let row: { id: string; risk_level: string | null; next_review_on: string | null };
  try {
    const { rows } = await client.query<typeof row>(
      `INSERT INTO case_decisions (case_id, decision, justification, suspicious_indicators,
                                   suspicion_notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, risk_level, to_char(next_review_on, 'YYYY-MM-DD') AS next_review_on`,
      [
        id,
        d.decision,
        d.justification,
        d.suspiciousIndicators,
        d.suspiciousIndicators ? d.suspicionNotes : null,
      ],
    );
    row = rows[0]!;
  } catch (error) {
    // The decision rules' messages (42501) become rule violations shown to the broker.
    translateDbError(error);
  }
  await recordAudit(client, {
    action: 'case.decided',
    entityType: 'case',
    entityId: id,
    after: {
      decisionId: row.id,
      decision: d.decision,
      justification: d.justification,
      suspiciousIndicators: d.suspiciousIndicators,
      suspicionNotes: d.suspiciousIndicators ? d.suspicionNotes : null,
      riskLevel: row.risk_level,
      nextReviewOn: row.next_review_on,
    },
  });
  return { id: row.id, complianceStatus: await refreshCompliance(client, id) };
}

/** Approvals, escalations and final decisions of a case, newest first. */
export async function listDecisions(
  client: PoolClient,
  caseId: string,
): Promise<{
  approvals: Approval[];
  escalations: Escalation[];
  final: FinalDecision[];
  revisions: CaseRevision[];
}> {
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
  const { rows: final } = await client.query<FinalDecision>(
    `SELECT d.id, d.decision, d.justification, d.suspicious_indicators AS "suspiciousIndicators",
            d.suspicion_notes AS "suspicionNotes", d.risk_level AS "riskLevel",
            to_char(d.next_review_on, 'YYYY-MM-DD') AS "nextReviewOn",
            d.legal_regime AS "legalRegime", d.decided_by AS "decidedBy",
            u.full_name AS "decidedByName", d.decided_at AS "decidedAt"
       FROM case_decisions d JOIN users u ON u.id = d.decided_by
      WHERE d.case_id = $1 ORDER BY d.decided_at DESC, d.id DESC`,
    [id],
  );
  return { approvals, escalations, final, revisions: await listRevisions(client, id) };
}
