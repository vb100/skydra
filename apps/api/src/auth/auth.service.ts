import { Email, PlanCode } from '@skydra/shared';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withPlatform } from '../platform/platform';
import {
  decrypt,
  encrypt,
  generateRecoveryCodes,
  hashRecoveryCode,
  hashToken,
  randomToken,
  type SecretKeys,
} from './crypto';
import { hashPassword, NewPassword, verifyPassword } from './passwords';
import { newTotpSecret, totpUri, verifyTotp } from './totp';

export type AuthDeps = { pool: Pool; keys: SecretKeys };

export const SESSION_POLICY = {
  /** Between a correct password and the second factor. */
  pendingMinutes: 5,
  /** Absolute lifetime of a signed-in session. */
  absoluteHours: 12,
  /** Signed out after this much inactivity. */
  idleMinutes: 30,
  maxFailedAttempts: 5,
  lockMinutes: 15,
} as const;

const LINK_TTL = { INVITE: '72 hours', PASSWORD_RESET: '24 hours' } as const;

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'invalid_code'
  | 'invalid_link'
  | 'no_session'
  | 'forbidden'
  | 'invalid_input';

export class AuthError extends Error {
  override name = 'AuthError';
  constructor(
    readonly code: AuthErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

export type Session = {
  id: string;
  userId: string;
  mfaVerified: boolean;
  activeOrganizationId: string | null;
};

type ClientMeta = { ip?: string; userAgent?: string };

async function inTransaction<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function registerFailure(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    `UPDATE user_credentials
        SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
            locked_until = CASE WHEN failed_attempts + 1 >= $2
                                THEN now() + make_interval(mins => $3) ELSE locked_until END,
            updated_at = now()
      WHERE user_id = $1`,
    [userId, SESSION_POLICY.maxFailedAttempts, SESSION_POLICY.lockMinutes],
  );
}

async function createSession(
  client: PoolClient | Pool,
  userId: string,
  mfaVerified: boolean,
  meta: ClientMeta,
): Promise<string> {
  const token = randomToken();
  const lifetime = mfaVerified
    ? `${SESSION_POLICY.absoluteHours} hours`
    : `${SESSION_POLICY.pendingMinutes} minutes`;
  await client.query(
    `INSERT INTO sessions (id, user_id, mfa_verified, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + $4::interval, $5, $6)`,
    [hashToken(token), userId, mfaVerified, lifetime, meta.ip ?? null, meta.userAgent ?? null],
  );
  return token;
}

/**
 * Step 1: e-mail and password. Every failure looks the same to the caller (unknown e-mail, wrong
 * password, locked or not yet activated account), and an unknown e-mail costs the same argon2
 * work. Success yields a short-lived session that is only good for the second factor.
 */
export async function login(
  deps: AuthDeps,
  input: { email: string; password: string },
  meta: ClientMeta = {},
): Promise<{ pendingToken: string }> {
  const email = Email.safeParse(input.email);
  const { rows: users } = email.success
    ? await deps.pool.query<{ user_id: string; status: string }>(
        'SELECT user_id, status FROM app.auth_find_user($1)',
        [email.data],
      )
    : { rows: [] };
  const user = users[0];

  const { rows: creds } = user
    ? await deps.pool.query<{ password_hash: string; locked: boolean }>(
        'SELECT password_hash, coalesce(locked_until > now(), false) AS locked FROM user_credentials WHERE user_id = $1',
        [user.user_id],
      )
    : { rows: [] };
  const cred = creds[0];

  const passwordOk = await verifyPassword(cred?.password_hash ?? null, input.password);
  if (!user || !cred || user.status !== 'ACTIVE' || cred.locked) {
    throw new AuthError('invalid_credentials');
  }
  if (!passwordOk) {
    await registerFailure(deps.pool, user.user_id);
    throw new AuthError('invalid_credentials');
  }
  return { pendingToken: await createSession(deps.pool, user.user_id, false, meta) };
}

/**
 * Step 2: TOTP code or a one-time recovery code. Failures count towards the same lockout as
 * passwords, so the 6-digit code cannot be brute-forced. On success the pending session is
 * replaced by a new one (new token), which prevents session fixation.
 */
export async function verifySecondFactor(
  deps: AuthDeps,
  pendingToken: string,
  input: { code?: string; recoveryCode?: string },
  meta: ClientMeta = {},
): Promise<{ sessionToken: string }> {
  const { rows: sessions } = await deps.pool.query<{ user_id: string }>(
    `SELECT user_id FROM sessions
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > now() AND NOT mfa_verified`,
    [hashToken(pendingToken)],
  );
  const userId = sessions[0]?.user_id;
  if (!userId) throw new AuthError('no_session');

  const { rows: creds } = await deps.pool.query<{
    totp_secret_encrypted: string;
    totp_last_step: string;
    locked: boolean;
  }>(
    'SELECT totp_secret_encrypted, totp_last_step, coalesce(locked_until > now(), false) AS locked FROM user_credentials WHERE user_id = $1',
    [userId],
  );
  const cred = creds[0];
  if (!cred || cred.locked) {
    await logout(deps, pendingToken);
    throw new AuthError('invalid_code');
  }

  let accepted = false;
  if (input.code) {
    const secret = decrypt(deps.keys.totpEncryption, cred.totp_secret_encrypted);
    const step = verifyTotp(secret, input.code.trim(), Number(cred.totp_last_step));
    if (step !== null) {
      // The WHERE clause makes concurrent use of the same code succeed at most once.
      const { rowCount } = await deps.pool.query(
        'UPDATE user_credentials SET totp_last_step = $2 WHERE user_id = $1 AND totp_last_step < $2',
        [userId, step],
      );
      accepted = rowCount === 1;
    }
  } else if (input.recoveryCode) {
    const { rowCount } = await deps.pool.query(
      'UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
      [userId, hashRecoveryCode(deps.keys.recoveryCodeHmac, input.recoveryCode)],
    );
    accepted = rowCount === 1;
  }

  if (!accepted) {
    await registerFailure(deps.pool, userId);
    throw new AuthError('invalid_code');
  }

  const sessionToken = await inTransaction(deps.pool, async (c) => {
    await c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [
      hashToken(pendingToken),
    ]);
    await c.query(
      'UPDATE user_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1',
      [userId],
    );
    return createSession(c, userId, true, meta);
  });
  return { sessionToken };
}

/**
 * Resolves a cookie token. Enforces expiry, idle timeout and that the user is still active;
 * touches `last_seen_at` so activity extends the idle window (never the absolute lifetime).
 */
export async function getSession(deps: AuthDeps, token: string): Promise<Session | null> {
  return inTransaction(deps.pool, async (c) => {
    const { rows } = await c.query<{
      id: string;
      user_id: string;
      mfa_verified: boolean;
      active_organization_id: string | null;
    }>(
      `UPDATE sessions SET last_seen_at = now()
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
          AND last_seen_at > now() - make_interval(mins => $2)
        RETURNING id, user_id, mfa_verified, active_organization_id`,
      [hashToken(token), SESSION_POLICY.idleMinutes],
    );
    const s = rows[0];
    if (!s) return null;

    await c.query("SELECT set_config('app.user_id', $1, true)", [s.user_id]);
    const { rows: users } = await c.query<{ status: string }>(
      'SELECT status FROM users WHERE id = $1',
      [s.user_id],
    );
    if (users[0]?.status !== 'ACTIVE') {
      await c.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [s.id]);
      return null;
    }
    return {
      id: s.id,
      userId: s.user_id,
      mfaVerified: s.mfa_verified,
      activeOrganizationId: s.active_organization_id,
    };
  });
}

export async function logout(deps: AuthDeps, token: string): Promise<void> {
  await deps.pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [hashToken(token)],
  );
}

export type MembershipSummary = {
  organizationId: string;
  organizationName: string;
  planCode: PlanCode;
  roles: string[];
  permissions: string[];
};

export async function describeUser(deps: AuthDeps, userId: string) {
  return withPlatform(deps.pool, userId, async (c) => {
    const { rows: users } = await c.query<{ id: string; email: string; full_name: string }>(
      'SELECT id, email, full_name FROM users WHERE id = app.current_user_id()',
    );
    const { rows: admin } = await c.query<{ is_platform_admin: boolean }>(
      'SELECT app.is_platform_admin() AS is_platform_admin',
    );
    const { rows: memberships } = await c.query<{
      organization_id: string;
      organization_name: string;
      plan_code: string;
      roles: string[];
      permissions: string[];
    }>('SELECT * FROM app.auth_user_memberships()');
    const user = users[0];
    if (!user) throw new AuthError('no_session');
    return {
      user: { id: user.id, email: user.email, fullName: user.full_name },
      isPlatformAdmin: admin[0]?.is_platform_admin === true,
      memberships: memberships.map((m): MembershipSummary => ({
        organizationId: m.organization_id,
        organizationName: m.organization_name,
        planCode: PlanCode.parse(m.plan_code),
        roles: m.roles,
        permissions: m.permissions,
      })),
    };
  });
}

export async function selectOrganization(
  deps: AuthDeps,
  session: Session,
  organizationId: string,
): Promise<void> {
  const id = z.uuid().safeParse(organizationId);
  if (!id.success) throw new AuthError('invalid_input');
  const { memberships } = await describeUser(deps, session.userId);
  if (!memberships.some((m) => m.organizationId === id.data)) throw new AuthError('forbidden');
  await deps.pool.query('UPDATE sessions SET active_organization_id = $2 WHERE id = $1', [
    session.id,
    id.data,
  ]);
}

/**
 * Issues an invitation or password-reset link. All authorization rules live in
 * app.auth_issue_link; here we only create the token and translate refusals.
 */
export async function issueLink(
  deps: AuthDeps,
  actor: { userId: string; activeOrganizationId: string | null },
  target: { userId: string; organizationId: string; purpose: 'INVITE' | 'PASSWORD_RESET' },
): Promise<{ token: string }> {
  const ids = z.object({ userId: z.uuid(), organizationId: z.uuid() }).safeParse(target);
  if (!ids.success) throw new AuthError('invalid_input');
  const token = randomToken();
  try {
    await inTransaction(deps.pool, async (c) => {
      await c.query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.organization_id', $2, true)",
        [actor.userId, actor.activeOrganizationId ?? ''],
      );
      await c.query('SELECT app.auth_issue_link($1, $2, $3, $4, $5::interval)', [
        ids.data.userId,
        ids.data.organizationId,
        target.purpose,
        hashToken(token),
        LINK_TTL[target.purpose],
      ]);
    });
  } catch (error) {
    if ((error as { code?: string }).code === '42501') {
      throw new AuthError('forbidden', (error as Error).message);
    }
    throw error;
  }
  return { token };
}

async function peekLink(deps: AuthDeps, token: string) {
  const { rows } = await deps.pool.query<{
    purpose: 'INVITE' | 'PASSWORD_RESET';
    email: string;
    full_name: string;
    pending_totp_secret_encrypted: string | null;
  }>('SELECT * FROM app.auth_peek_link($1)', [hashToken(token)]);
  return rows[0] ?? null;
}

export async function describeLink(deps: AuthDeps, token: string) {
  const link = await peekLink(deps, token);
  if (!link) throw new AuthError('invalid_link');
  return { purpose: link.purpose, email: link.email, fullName: link.full_name };
}

/** Proposes a new TOTP secret for the link; the user scans it before completing. */
export async function startLink(deps: AuthDeps, token: string) {
  const link = await peekLink(deps, token);
  if (!link) throw new AuthError('invalid_link');
  const secret = newTotpSecret();
  const { rows } = await deps.pool.query<{ ok: boolean }>(
    'SELECT app.auth_set_link_totp($1, $2) AS ok',
    [hashToken(token), encrypt(deps.keys.totpEncryption, secret)],
  );
  if (!rows[0]?.ok) throw new AuthError('invalid_link');
  return { otpauthUri: totpUri(secret, link.email), secret };
}

/**
 * Sets the password and second factor in one step. Returns the recovery codes, which are shown
 * to the user exactly once and stored only as keyed hashes.
 */
export async function completeLink(
  deps: AuthDeps,
  input: { token: string; password: string; totpCode: string },
): Promise<{ recoveryCodes: string[] }> {
  const password = NewPassword.safeParse(input.password);
  if (!password.success) {
    throw new AuthError('invalid_input', password.error.issues[0]?.message);
  }
  const link = await peekLink(deps, input.token);
  if (!link?.pending_totp_secret_encrypted) throw new AuthError('invalid_link');

  const secret = decrypt(deps.keys.totpEncryption, link.pending_totp_secret_encrypted);
  const step = verifyTotp(secret, input.totpCode.trim(), 0);
  if (step === null) throw new AuthError('invalid_code');

  const recoveryCodes = generateRecoveryCodes();
  try {
    await deps.pool.query('SELECT app.auth_complete_link($1, $2, $3, $4)', [
      hashToken(input.token),
      await hashPassword(password.data),
      recoveryCodes.map((c) => hashRecoveryCode(deps.keys.recoveryCodeHmac, c)),
      step,
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === '42501') throw new AuthError('invalid_link');
    throw error;
  }
  return { recoveryCodes };
}
