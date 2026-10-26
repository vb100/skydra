import { describe, expect, it } from 'vitest';
import { redact } from './audit';

describe('redact', () => {
  it('masks secret-looking keys at any depth', () => {
    expect(
      redact({
        email: 'a@b.lt',
        passwordHash: 'x',
        nested: { totpSecret: 'y', items: [{ resetToken: 'z', name: 'ok' }] },
      }),
    ).toEqual({
      email: 'a@b.lt',
      passwordHash: '[REDACTED]',
      nested: { totpSecret: '[REDACTED]', items: [{ resetToken: '[REDACTED]', name: 'ok' }] },
    });
  });

  it('keeps ordinary values unchanged', () => {
    expect(redact({ name: 'Jonas', riskLevel: 'HIGH', shares: [60, 40] })).toEqual({
      name: 'Jonas',
      riskLevel: 'HIGH',
      shares: [60, 40],
    });
    expect(redact(null)).toBeNull();
    expect(redact('text')).toBe('text');
  });
});
