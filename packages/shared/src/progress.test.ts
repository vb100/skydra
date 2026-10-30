import { describe, expect, it } from 'vitest';
import { type ChecklistResult, caseSteps, nextStep } from './progress';

const e = (item: ChecklistResult['item'], ok: boolean, casePartyId: string | null = null) => ({
  item,
  ok,
  casePartyId,
});
const states = (c: ChecklistResult[]) => caseSteps(c).map((s) => `${s.step}:${s.state}`);

describe('case progress', () => {
  it('a new case without parties is at the parties step', () => {
    const c = [e('PARTIES_ADDED', false), e('RISK_ASSESSED', false)];
    expect(states(c)).toEqual([
      'TRANSACTION:done',
      'PARTIES:current',
      'SCREENING:todo',
      'IDENTITY:todo',
      'RISK:todo',
      'COMPLETION:todo',
    ]);
    expect(nextStep(c)).toMatchObject({ item: 'PARTIES_ADDED' });
  });

  it('points to the earliest step, and within it the earliest item, with the party', () => {
    const c = [
      e('PARTIES_ADDED', true),
      e('SCREENED', true, 'p1'),
      e('MATCHES_REVIEWED', false, 'p1'),
      e('IDENTITY_VERIFIED', false, 'p1'),
      e('CDD_COMPLETED', false, 'p1'),
      e('RISK_ASSESSED', false),
    ];
    expect(states(c).slice(2)).toEqual([
      'SCREENING:current',
      'IDENTITY:todo',
      'RISK:todo',
      'COMPLETION:todo',
    ]);
    expect(nextStep(c)).toEqual(e('MATCHES_REVIEWED', false, 'p1'));
  });

  it('a stopping condition blocks its step and comes first', () => {
    const c = [
      e('PARTIES_ADDED', true),
      e('IDENTITY_VERIFIED', false, 'p1'),
      e('NO_CONFIRMED_SANCTIONS', false),
    ];
    expect(caseSteps(c).find((s) => s.step === 'SCREENING')?.state).toBe('blocked');
    expect(nextStep(c)?.item).toBe('NO_CONFIRMED_SANCTIONS');
  });

  it('a complete case has every step done and nothing next', () => {
    const c = [e('PARTIES_ADDED', true), e('RISK_ASSESSED', true), e('NO_OPEN_ESCALATION', true)];
    expect(caseSteps(c).every((s) => s.state === 'done')).toBe(true);
    expect(nextStep(c)).toBeNull();
  });
});
