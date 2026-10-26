import { Email, Permission, Role } from '@skydra/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';

export const AddMemberInput = z.object({
  email: Email,
  fullName: z.string().trim().min(1).max(200),
  roles: z.array(Role).min(1),
  permissions: z.array(Permission).default([]),
});
export type AddMemberInput = z.input<typeof AddMemberInput>;

export const UpdateMemberInput = z
  .object({
    roles: z.array(Role).min(1).optional(),
    permissions: z.array(Permission).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
export type UpdateMemberInput = z.input<typeof UpdateMemberInput>;

export type Member = {
  userId: string;
  email: string;
  fullName: string;
  userStatus: 'INVITED' | 'ACTIVE' | 'DISABLED';
  roles: string[];
  permissions: string[];
  status: 'ACTIVE' | 'DISABLED';
};

export class MemberError extends Error {
  override name = 'MemberError';
}

function translate(error: unknown): never {
  if ((error as { code?: string }).code === '42501')
    throw new MemberError((error as Error).message);
  throw error;
}

/** Members of the current organization (client must come from `withTenant`). */
export async function listMembers(client: PoolClient): Promise<Member[]> {
  const { rows } = await client.query<Member>(
    `SELECT u.id AS "userId", u.email, u.full_name AS "fullName", u.status AS "userStatus",
            m.roles, m.permissions, m.status
       FROM memberships m JOIN users u ON u.id = m.user_id
      ORDER BY m.status, u.full_name`,
  );
  return rows;
}

export async function addMember(
  client: PoolClient,
  input: AddMemberInput,
): Promise<{ userId: string; needsInvite: boolean }> {
  const i = AddMemberInput.parse(input);
  try {
    const { rows } = await client.query<{ user_id: string; needs_invite: boolean }>(
      'SELECT * FROM app.org_add_member($1, $2, $3, $4)',
      [i.email, i.fullName, [...new Set(i.roles)], [...new Set(i.permissions)]],
    );
    const r = rows[0];
    if (!r) throw new Error('member was not added');
    return { userId: r.user_id, needsInvite: r.needs_invite };
  } catch (error) {
    translate(error);
  }
}

/**
 * Changes roles, permissions or status. The database refuses it unless the caller is an active
 * organization admin, keeps at least one active admin and applies the seat limit on re-enabling.
 * The audit event records the values before and after.
 */
export async function updateMember(
  client: PoolClient,
  userId: string,
  input: UpdateMemberInput,
): Promise<void> {
  const id = z.uuid().parse(userId);
  const u = UpdateMemberInput.parse(input);
  const { rows: before } = await client.query<{
    roles: string[];
    permissions: string[];
    status: string;
  }>('SELECT roles, permissions, status FROM memberships WHERE user_id = $1', [id]);
  if (!before[0]) throw new MemberError('member not found');

  try {
    await client.query(
      `UPDATE memberships
          SET roles = coalesce($2, roles),
              permissions = coalesce($3, permissions),
              status = coalesce($4, status)
        WHERE user_id = $1`,
      [
        id,
        u.roles ? [...new Set(u.roles)] : null,
        u.permissions ? [...new Set(u.permissions)] : null,
        u.status ?? null,
      ],
    );
  } catch (error) {
    translate(error);
  }

  const { rows: after } = await client.query(
    'SELECT roles, permissions, status FROM memberships WHERE user_id = $1',
    [id],
  );
  // A disabled member loses access to this organization on the next request: OrganizationGuard
  // reloads the membership every time. Their access to other organizations is unaffected.
  await recordAudit(client, {
    action: 'membership.updated',
    entityType: 'membership',
    entityId: id,
    before: before[0],
    after: after[0],
  });
}
