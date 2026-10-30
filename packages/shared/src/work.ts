import type { ChecklistItem } from './kyc';

/** Where a case belongs in someone's work list. */
export type WorkBucket =
  | 'decide' // an approval waiting for this approver
  | 'resolve' // an escalation waiting for this AML officer
  | 'action' // the responsible broker has something to do
  | 'waiting' // the responsible broker waits for an approver or the AML officer
  | 'blocked' // the transaction cannot proceed
  | 'done';

export type WorkCase = {
  responsibleUserId: string;
  complianceStatus: string;
  next: { item: ChecklistItem } | null;
  openApprovalBy: string | null;
  escalation: 'OPEN' | 'REPORTED' | null;
};

export type Viewer = {
  userId: string;
  canApprove: boolean;
  isAmlOfficer: boolean;
  /** One-member organization: the four-eyes rule does not apply. */
  solo: boolean;
};

/**
 * The bucket of a case for the person looking at it, or null when it is not their work. Approvals
 * and escalations go to whoever may decide them (four-eyes respected); everything else to the
 * responsible broker.
 */
export function workBucket(c: WorkCase, viewer: Viewer): WorkBucket | null {
  if (
    c.next?.item === 'EDD_APPROVED' &&
    c.openApprovalBy &&
    viewer.canApprove &&
    (viewer.solo || (viewer.userId !== c.responsibleUserId && viewer.userId !== c.openApprovalBy))
  )
    return 'decide';
  if (c.escalation === 'OPEN' && viewer.isAmlOfficer) return 'resolve';
  if (viewer.userId !== c.responsibleUserId) return null;

  if (!c.next) return c.complianceStatus === 'COMPLETED' ? 'done' : null;
  if (c.escalation === 'REPORTED' || c.next.item === 'APPROVAL_NOT_REJECTED') return 'blocked';
  if (c.escalation === 'OPEN') return 'waiting';
  if (c.next.item === 'EDD_APPROVED' && c.openApprovalBy) return 'waiting';
  // Confirmed sanctions are blocked too, but the broker still has to escalate them.
  return 'action';
}
