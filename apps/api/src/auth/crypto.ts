import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * Keys derived from the single SECRET_ENCRYPTION_KEY (32 bytes). Each purpose gets its own key so
 * that, for example, the key that encrypts TOTP secrets is never used to hash recovery codes.
 */
export type SecretKeys = {
  totpEncryption: Buffer;
  recoveryCodeHmac: Buffer;
  personalCodeEncryption: Buffer;
  personalCodeIndex: Buffer;
};

export function deriveKeys(masterKeyBase64: string): SecretKeys {
  const master = Buffer.from(masterKeyBase64, 'base64');
  if (master.length !== 32) throw new Error('SECRET_ENCRYPTION_KEY must be 32 bytes (base64)');
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, '', info, 32));
  return {
    totpEncryption: derive('skydra/totp-secret-encryption/v1'),
    recoveryCodeHmac: derive('skydra/recovery-code-hmac/v1'),
    personalCodeEncryption: derive('skydra/personal-code-encryption/v1'),
    personalCodeIndex: derive('skydra/personal-code-index/v1'),
  };
}

const VERSION = 'v1';

/** AES-256-GCM; output `v1.<iv>.<tag>.<ciphertext>` (base64url). Tampering fails decryption. */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decrypt(key: Buffer, payload: string): string {
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error('unsupported ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** 256-bit random token for cookies and one-time links. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are high-entropy, so a plain SHA-256 is enough to store them safely. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** Ten codes like `K7QD-M2XP-9RTA` (60 bits each), shown to the user once. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12);
    const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

/** Normalizes user input (case, spaces, dashes) before hashing. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Recovery codes have less entropy than tokens, so they are hashed with a server-side key: a
 * leaked database alone is not enough to brute-force them.
 */
export function hashRecoveryCode(key: Buffer, code: string): string {
  return createHmac('sha256', key).update(normalizeRecoveryCode(code)).digest('hex');
}

/**
 * Blind index for finding a person by personal code without storing it in clear. Keyed and bound
 * to the organization, so a leaked database neither reveals codes nor links people across agencies.
 */
export function personalCodeIndex(key: Buffer, organizationId: string, code: string): string {
  return createHmac('sha256', key)
    .update(`${organizationId}:${code.toUpperCase().replace(/[\s-]/g, '')}`)
    .digest('hex');
}
