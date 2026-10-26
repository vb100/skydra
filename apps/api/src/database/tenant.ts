import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export type TenantContext = {
  organizationId: string;
  userId: string;
};

const Uuid = z.uuid();

/**
 * Runs `work` inside one transaction bound to a single organization. Row-level security reads the
 * context from transaction-local settings, so every tenant query must go through here: without
 * it the database returns no rows at all instead of rows from other organizations.
 */
export async function withTenant<T>(
  pool: Pool,
  context: TenantContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const organizationId = Uuid.parse(context.organizationId);
  const userId = Uuid.parse(context.userId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
      [organizationId, userId],
    );
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
