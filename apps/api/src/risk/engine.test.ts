import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateRisk, nextReviewOn, type RiskFacts, RuleSetDefinition } from './engine';

// The rule set exactly as the migration inserts it, so a broken table fails here first.
const sql = readFileSync(join(__dirname, '../../migrations/0009_risk_assessment.sql'), 'utf8');
const demo = RuleSetDefinition.parse(JSON.parse(sql.split('$json$')[1]!));

const clean: RiskFacts = {
  pep: false,
  sanctions: false,
  adverseMedia: false,
  notOwnBehalf: false,
  legalEntityParty: false,
  representativeInvolved: false,
  remoteIdentification: false,
  partyCountries: ['LT'],
  paymentMethod: 'BANK_TRANSFER',
  thirdPartyPayer: false,
  transactionValueEur: 150000,
  sourceOfFundsMissing: false,
  complexOwnership: false,
};
const matched = (facts: Partial<RiskFacts>) =>
  evaluateRisk(demo, { ...clean, ...facts })
    .factors.filter((f) => f.matched)
    .map((f) => f.code);

describe('risk engine with LT-RISK-01 DEMO-1', () => {
  it('rates an ordinary domestic transaction LOW', () => {
    expect(evaluateRisk(demo, clean)).toMatchObject({
      calculatedLevel: 'LOW',
      mandatoryLevel: null,
      escalatedByMediumCount: false,
    });
  });

  it('makes a PEP HIGH with a mandatory minimum', () => {
    expect(evaluateRisk(demo, { ...clean, pep: true })).toMatchObject({
      calculatedLevel: 'HIGH',
      mandatoryLevel: 'HIGH',
    });
  });

  it('applies the country lists', () => {
    expect(matched({ partyCountries: ['LT', 'UA'] })).toEqual(['NON_EEA_COUNTRY']);
    expect(matched({ partyCountries: ['IR'] })).toEqual(['HIGH_RISK_COUNTRY', 'NON_EEA_COUNTRY']);
    expect(evaluateRisk(demo, { ...clean, partyCountries: ['IR'] }).mandatoryLevel).toBe('HIGH');
  });

  it('applies payment and value conditions', () => {
    expect(matched({ paymentMethod: 'CASH' })).toEqual(['CASH']);
    expect(matched({ paymentMethod: 'MIXED' })).toEqual(['MIXED_PAYMENT']);
    expect(matched({ transactionValueEur: 999_999 })).toEqual([]);
    expect(matched({ transactionValueEur: 1_000_000 })).toEqual(['HIGH_VALUE']);
    expect(matched({ transactionValueEur: null })).toEqual([]);
  });

  it('two MEDIUM factors stay MEDIUM; three make it HIGH', () => {
    const two = evaluateRisk(demo, { ...clean, legalEntityParty: true, thirdPartyPayer: true });
    expect(two.calculatedLevel).toBe('MEDIUM');
    const three = evaluateRisk(demo, {
      ...clean,
      legalEntityParty: true,
      thirdPartyPayer: true,
      remoteIdentification: true,
    });
    expect(three).toMatchObject({ calculatedLevel: 'HIGH', escalatedByMediumCount: true });
    expect(three.mandatoryLevel).toBeNull();
  });

  it('sets the next review from the level', () => {
    const from = new Date('2026-10-26T12:00:00Z');
    expect(nextReviewOn(demo, 'LOW', from)).toBe('2031-10-26');
    expect(nextReviewOn(demo, 'MEDIUM', from)).toBe('2029-10-26');
    expect(nextReviewOn(demo, 'HIGH', from)).toBe('2027-10-26');
  });

  it('refuses a malformed rule set', () => {
    const broken = { ...demo, factors: [{ ...demo.factors[0], in: ['X'] }] };
    expect(RuleSetDefinition.safeParse(broken).success).toBe(false);
    const unknownList = {
      ...demo,
      factors: [
        { code: 'X', group: 'GEOGRAPHY', fact: 'partyCountries', anyInList: 'nope', level: 'LOW' },
      ],
    };
    expect(RuleSetDefinition.safeParse(unknownList).success).toBe(false);
  });
});
