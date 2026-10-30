import { describe, expect, it } from 'vitest';
import { type WorkCase, workBucket } from './work';

const broker = { userId: 'b', canApprove: false, isAmlOfficer: false, solo: false };
const approver = { userId: 'a', canApprove: true, isAmlOfficer: false, solo: false };
const officer = { userId: 'o', canApprove: false, isAmlOfficer: true, solo: false };
const base: WorkCase = {
  responsibleUserId: 'b',
  complianceStatus: 'IN_PROGRESS',
  next: { item: 'IDENTITY_VERIFIED' },
  openApprovalBy: null,
  escalation: null,
};

describe('work buckets', () => {
  it('the responsible broker acts; others do not see it as theirs', () => {
    expect(workBucket(base, broker)).toBe('action');
    expect(workBucket(base, approver)).toBeNull();
  });

  it('an open approval is the approver’s decision and the broker’s wait, with four eyes', () => {
    const c = { ...base, next: { item: 'EDD_APPROVED' as const }, openApprovalBy: 'b' };
    expect(workBucket(c, approver)).toBe('decide');
    expect(workBucket(c, broker)).toBe('waiting');
    // An approver responsible for the case cannot decide it, unless the organization is solo.
    expect(workBucket({ ...c, responsibleUserId: 'a' }, approver)).toBe('waiting');
    expect(workBucket({ ...c, responsibleUserId: 'a' }, { ...approver, solo: true })).toBe(
      'decide',
    );
  });

  it('an open escalation is the AML officer’s; reported or rejected cases are blocked', () => {
    const open = {
      ...base,
      next: { item: 'NO_OPEN_ESCALATION' as const },
      escalation: 'OPEN' as const,
    };
    expect(workBucket(open, officer)).toBe('resolve');
    expect(workBucket(open, broker)).toBe('waiting');
    expect(workBucket({ ...open, escalation: 'REPORTED' }, broker)).toBe('blocked');
    expect(workBucket({ ...base, next: { item: 'APPROVAL_NOT_REJECTED' } }, broker)).toBe(
      'blocked',
    );
  });

  it('confirmed sanctions still need the broker to escalate', () => {
    expect(workBucket({ ...base, next: { item: 'NO_CONFIRMED_SANCTIONS' } }, broker)).toBe(
      'action',
    );
  });

  it('a completed case is done; a case outside AML is not work', () => {
    expect(workBucket({ ...base, next: null, complianceStatus: 'COMPLETED' }, broker)).toBe('done');
    expect(workBucket({ ...base, next: null, complianceStatus: 'NOT_STARTED' }, broker)).toBeNull();
  });
});
