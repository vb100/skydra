import { Email, PlanCode } from '@skydra/shared';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const Uuid = z.uuid();

/**
 * Transaction for SkyDra platform administration. Only the acting user is set — there is no
 * organization context, so tenant data stays invisible; platform operations go through
 * SECURITY DEFINER functions that verify platform-admin status in the database.
 */
export async function withPlatform<T>(
  pool: Pool,
  userId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const id = Uuid.parse(userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [id]);
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

export const CreateOrganizationInput = z.object({
  name: z.string().trim().min(1).max(200),
  planCode: PlanCode,
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default('LT'),
  adminEmail: Email,
  adminFullName: z.string().trim().min(1).max(200),
});
export type CreateOrganizationInput = z.input<typeof CreateOrganizationInput>;

export async function createOrganization(
  client: PoolClient,
  input: CreateOrganizationInput,
): Promise<{ organizationId: string; adminUserId: string }> {
  const i = CreateOrganizationInput.parse(input);
  const { rows } = await client.query<{ organization_id: string; admin_user_id: string }>(
    'SELECT * FROM app.platform_create_organization($1, $2, $3, $4, $5)',
    [i.name, i.planCode, i.adminEmail, i.adminFullName, i.countryCode],
  );
  const r = rows[0];
  if (!r) throw new Error('organization was not created');
  return { organizationId: r.organization_id, adminUserId: r.admin_user_id };
}
