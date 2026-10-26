import { Permission, PlanCode, Role } from '@skydra/shared';
import type { PoolClient } from 'pg';
import { effectiveEntitlements } from './entitlements';
import type { Principal } from './policy';

/**
 * Resolves the acting member inside a `withTenant` transaction. Returns null when the user has no
 * active membership in the organization or the organization is suspended, so callers cannot
 * accidentally continue with a half-valid identity.
 */
export async function loadPrincipal(client: PoolClient): Promise<Principal | null> {
  const { rows } = await client.query<{
    user_id: string;
    organization_id: string;
    roles: string[];
    permissions: string[];
    plan_code: string;
    features: string[];
    limits: unknown;
    entitlement_overrides: unknown;
  }>(
    `SELECT m.user_id, m.organization_id, m.roles, m.permissions,
            o.plan_code, p.features, p.limits, o.entitlement_overrides
       FROM memberships m
       JOIN organizations o ON o.id = m.organization_id
       JOIN plans p ON p.code = o.plan_code
       JOIN users u ON u.id = m.user_id
      WHERE m.user_id = app.current_user_id()
        AND m.organization_id = app.current_organization_id()
        AND m.status = 'ACTIVE'
        AND o.status = 'ACTIVE'
        AND u.status = 'ACTIVE'`,
  );
  const r = rows[0];
  if (!r) return null;

  const plan = PlanCode.parse(r.plan_code);
  return {
    userId: r.user_id,
    organizationId: r.organization_id,
    roles: new Set(r.roles.map((x) => Role.parse(x))),
    permissions: new Set(r.permissions.map((x) => Permission.parse(x))),
    entitlements: effectiveEntitlements(plan, r.features, r.limits, r.entitlement_overrides),
  };
}
