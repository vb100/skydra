import argon2 from 'argon2';
import { z } from 'zod';

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations, 1 lane) are the floor; we use the
// library defaults (64 MiB, 3 iterations, 4 lanes), which are stronger.
const OPTIONS = { type: argon2.argon2id } as const;

/** Length is what matters (NIST SP 800-63B): at least 12 characters, no composition rules. */
export const NewPassword = z
  .string()
  .min(12, 'Slaptažodis turi būti ne trumpesnis nei 12 simbolių')
  .max(256)
  .refine((p) => p.trim().length >= 12, 'Slaptažodis negali būti sudarytas vien iš tarpų');

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password. For unknown users we still run a full argon2 verification against a dummy
 * hash, so response time does not reveal whether an e-mail address has an account.
 */
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (hash === null) {
    dummyHash ??= argon2.hash('not-a-real-password', OPTIONS);
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return argon2.verify(hash, password).catch(() => false);
}
