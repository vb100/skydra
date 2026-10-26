import { Feature, type PlanCode } from '@skydra/shared';
import { z } from 'zod';

export type Entitlements = {
  plan: PlanCode;
  features: ReadonlySet<Feature>;
  /** `null` means unlimited. */
  maxUsers: number | null;
};

const Limits = z.object({ maxUsers: z.number().int().positive().nullable().optional() });

/**
 * Per-organization adjustments a platform admin can make on top of the plan, e.g. a pilot agency
 * on AGENCY that also gets WHITE_LABEL, or a larger seat limit.
 */
const Overrides = z.object({
  addFeatures: z.array(Feature).optional(),
  removeFeatures: z.array(Feature).optional(),
  maxUsers: z.number().int().positive().nullable().optional(),
});

export function effectiveEntitlements(
  plan: PlanCode,
  planFeatures: readonly string[],
  planLimits: unknown,
  overrides: unknown,
): Entitlements {
  const limits = Limits.parse(planLimits ?? {});
  const o = Overrides.parse(overrides ?? {});

  const features = new Set(planFeatures.map((f) => Feature.parse(f)));
  for (const f of o.addFeatures ?? []) features.add(f);
  for (const f of o.removeFeatures ?? []) features.delete(f);

  return {
    plan,
    features,
    maxUsers: o.maxUsers !== undefined ? o.maxUsers : (limits.maxUsers ?? null),
  };
}

export function hasFeature(entitlements: Entitlements, feature: Feature): boolean {
  return entitlements.features.has(feature);
}

/**
 * Seats are the one hard plan limit: they define what a plan is (one broker vs. a team).
 * Limits on AML checks are deliberately not enforced here — a plan must never stop a mandatory
 * check — and will be soft limits with overage accounting.
 */
export function canAddMember(entitlements: Entitlements, activeMembers: number): boolean {
  return entitlements.maxUsers === null || activeMembers < entitlements.maxUsers;
}
