import { describe, expect, it } from 'vitest';
import { AddCasePartyInput, amlApplicability, CreateCaseInput } from './cases';

describe('AML applicability', () => {
  it('always applies to sales', () => {
    expect(amlApplicability('SALE', null)).toBe('APPLICABLE');
  });

  it('applies to lettings from EUR 10 000 per month', () => {
    expect(amlApplicability('RENT', 9999.99)).toBe('NOT_APPLICABLE_RENT_THRESHOLD');
    expect(amlApplicability('RENT', 10000)).toBe('APPLICABLE');
  });
});

describe('case input', () => {
  const base = { propertyType: 'HOUSE', propertyAddress: 'Vilnius' } as const;

  it('requires the amount that matches the transaction type', () => {
    expect(CreateCaseInput.safeParse({ ...base, transactionType: 'SALE' }).success).toBe(false);
    expect(
      CreateCaseInput.safeParse({ ...base, transactionType: 'RENT', monthlyRent: '850' }).data
        ?.monthlyRent,
    ).toBe(850);
  });

  it('requires a description for another payment method', () => {
    const sale = { ...base, transactionType: 'SALE', transactionValue: 1 } as const;
    expect(CreateCaseInput.safeParse({ ...sale, paymentMethod: 'OTHER' }).success).toBe(false);
    expect(
      CreateCaseInput.safeParse({ ...sale, paymentMethod: 'OTHER', paymentMethodOther: 'Kripto' })
        .success,
    ).toBe(true);
  });
});

describe('case party input', () => {
  const person = { partyType: 'NATURAL', firstName: 'A', lastName: 'B' } as const;

  it('takes either an existing party or a new one', () => {
    const role = { role: 'BUYER', isOurClient: true } as const;
    expect(AddCasePartyInput.safeParse({ ...role, party: person }).success).toBe(true);
    expect(AddCasePartyInput.safeParse(role).success).toBe(false);
    expect(
      AddCasePartyInput.safeParse({
        ...role,
        party: person,
        partyId: '5b0f0a8e-8f8c-4f39-9d4c-3c8a2b1f0e11',
      }).success,
    ).toBe(false);
  });

  it('requires reliance details when CDD relies on another entity', () => {
    const input = { role: 'SELLER', isOurClient: false, party: person, cddScope: 'RELIANCE' };
    expect(AddCasePartyInput.safeParse(input).success).toBe(false);
    expect(
      AddCasePartyInput.safeParse({ ...input, reliance: { entityName: 'UAB Kitas' } }).success,
    ).toBe(true);
  });
});
