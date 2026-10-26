import { Secret, TOTP } from 'otpauth';

const PERIOD = 30;
const ISSUER = 'SkyDra';

function totp(secretBase32: string, label = 'SkyDra'): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1', // what authenticator apps support universally
    digits: 6,
    period: PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(secretBase32: string, email: string): string {
  return totp(secretBase32, email).toString();
}

/**
 * Accepts the current code or one step either side (clock drift). Returns the accepted time step,
 * or null. Codes at or before `lastUsedStep` are rejected, so an observed code cannot be replayed.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastUsedStep: number,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totp(secretBase32).validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / PERIOD) + delta;
  return step > lastUsedStep ? step : null;
}

/** For tests and the activation preview only. */
export function currentTotpCode(secretBase32: string, now = Date.now()): string {
  return totp(secretBase32).generate({ timestamp: now });
}
