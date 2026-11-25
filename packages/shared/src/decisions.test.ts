import { describe, expect, it } from 'vitest';
import { RecordDecisionInput } from './kyc';
import { nextStep } from './progress';

describe('final decision input', () => {
  const valid = {
    decision: 'APPROVE',
    justification: 'Visi reikalavimai įvykdyti',
    suspiciousIndicators: false,
  } as const;

  it('needs reasons, and notes when suspicious indicators were found', () => {
    expect(RecordDecisionInput.safeParse(valid).success).toBe(true);
    expect(RecordDecisionInput.safeParse({ ...valid, justification: 'Trumpai' }).success).toBe(
      false,
    );
    expect(
      RecordDecisionInput.safeParse({ ...valid, decision: 'DECLINE', suspiciousIndicators: true })
        .success,
    ).toBe(false);
    expect(
      RecordDecisionInput.safeParse({
        ...valid,
        decision: 'DECLINE',
        suspiciousIndicators: true,
        suspicionNotes: 'Mokėjimas per trečiąjį asmenį',
      }).success,
    ).toBe(true);
    expect(RecordDecisionInput.safeParse({ ...valid, decision: 'REQUEST_INFO' }).success).toBe(
      false,
    );
  });

  it('is the last step of a case', () => {
    expect(
      nextStep([
        { casePartyId: null, item: 'DECISION_RECORDED', ok: false },
        { casePartyId: null, item: 'RISK_ASSESSED', ok: false },
      ])?.item,
    ).toBe('RISK_ASSESSED');
  });
});
