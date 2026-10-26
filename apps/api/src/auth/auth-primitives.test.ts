import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decrypt,
  deriveKeys,
  encrypt,
  generateRecoveryCodes,
  hashRecoveryCode,
  hashToken,
  randomToken,
} from './crypto';
import { hashPassword, NewPassword, verifyPassword } from './passwords';
import { currentTotpCode, newTotpSecret, verifyTotp } from './totp';

const keys = deriveKeys(randomBytes(32).toString('base64'));

describe('crypto', () => {
  it('derives distinct keys per purpose and rejects a wrong-length master key', () => {
    expect(keys.totpEncryption.equals(keys.recoveryCodeHmac)).toBe(false);
    expect(() => deriveKeys(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('round-trips encryption with a fresh IV every time', () => {
    const a = encrypt(keys.totpEncryption, 'JBSWY3DPEHPK3PXP');
    const b = encrypt(keys.totpEncryption, 'JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(decrypt(keys.totpEncryption, a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses tampered ciphertext and the wrong key', () => {
    const payload = encrypt(keys.totpEncryption, 'secret');
    const parts = payload.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString('base64url');
    expect(() => decrypt(keys.totpEncryption, parts.join('.'))).toThrow();
    expect(() => decrypt(keys.recoveryCodeHmac, payload)).toThrow();
  });

  it('creates unguessable tokens and stores only their hash', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });

  it('generates distinct recovery codes and hashes them independent of formatting', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const code = codes[0]!;
    expect(hashRecoveryCode(keys.recoveryCodeHmac, code.toLowerCase().replaceAll('-', ' '))).toBe(
      hashRecoveryCode(keys.recoveryCodeHmac, code),
    );
  });
});

describe('TOTP', () => {
  const secret = newTotpSecret();
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);

  it('accepts the current code and returns its time step', () => {
    expect(verifyTotp(secret, currentTotpCode(secret, now), 0, now)).toBe(now / 30_000);
  });

  it('tolerates one step of clock drift but not more', () => {
    expect(verifyTotp(secret, currentTotpCode(secret, now - 30_000), 0, now)).not.toBeNull();
    expect(verifyTotp(secret, currentTotpCode(secret, now - 90_000), 0, now)).toBeNull();
  });

  it('rejects a replayed code', () => {
    const code = currentTotpCode(secret, now);
    const step = verifyTotp(secret, code, 0, now)!;
    expect(verifyTotp(secret, code, step, now)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifyTotp(secret, '12345', 0, now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', 0, now)).toBeNull();
  });
});

describe('passwords', () => {
  it('requires at least 12 meaningful characters', () => {
    expect(NewPassword.safeParse('trumpas').success).toBe(false);
    expect(NewPassword.safeParse('            x').success).toBe(false);
    expect(NewPassword.safeParse('ilgas ir saugus slaptažodis').success).toBe(true);
  });

  it('hashes with argon2id and verifies', async () => {
    const hash = await hashPassword('ilgas ir saugus slaptažodis');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'ilgas ir saugus slaptažodis')).toBe(true);
    expect(await verifyPassword(hash, 'kitas slaptažodis')).toBe(false);
  });

  it('spends comparable time and returns false for unknown users', async () => {
    expect(await verifyPassword(null, 'bet koks')).toBe(false);
  });
});
