import type { Permission, Role } from '@skydra/shared';
import { describe, expect, it } from 'vitest';
import { canAddMember, effectiveEntitlements } from './entitlements';
import { type Action, can, type Principal } from './policy';

const agency = effectiveEntitlements(
  'AGENCY',
  ['MULTI_USER', 'TASK_ASSIGNMENT', 'APPROVAL_WORKFLOW'],
  { maxUsers: null },
  {},
);

function principal(
  roles: Role[],
  permissions: Permission[] = [],
  entitlements = agency,
): Principal {
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    roles: new Set(roles),
    permissions: new Set(permissions),
    entitlements,
  };
}

const allowed = (p: Principal) =>
  (
    [
      'organization.view',
      'organization.update',
      'member.view',
      'member.manage',
      'case.create',
      'case.view_own',
      'case.view_all',
      'case.approve',
      'case.assign',
      'aml.escalation_handle',
      'audit.view',
    ] as Action[]
  ).filter((a) => can(p, a));

describe('access policy', () => {
  it('keeps an organization admin away from cases (administration ≠ AML work)', () => {
    expect(allowed(principal(['ORG_ADMIN']))).toEqual([
      'organization.view',
      'organization.update',
      'member.view',
      'member.manage',
      'audit.view',
    ]);
  });

  it('lets a broker work own cases only', () => {
    expect(allowed(principal(['BROKER']))).toEqual([
      'organization.view',
      'case.create',
      'case.view_own',
    ]);
  });

  it('lets a manager see all cases, members and audit, and assign cases on Agency plans', () => {
    const p = principal(['MANAGER']);
    expect(can(p, 'case.view_all')).toBe(true);
    expect(can(p, 'case.assign')).toBe(true);
    expect(can(p, 'member.view')).toBe(true);
    expect(can(p, 'member.manage')).toBe(false);
    expect(can(p, 'case.approve')).toBe(false);
  });

  it('grants approval and AML-officer duties through permissions, not roles', () => {
    const p = principal(['BROKER'], ['APPROVER', 'AML_OFFICER', 'CASE_VIEW_ALL']);
    expect(can(p, 'case.approve')).toBe(true);
    expect(can(p, 'aml.escalation_handle')).toBe(true);
    expect(can(p, 'case.view_all')).toBe(true);
    expect(can(p, 'audit.view')).toBe(true);
  });

  it('gives a solo broker the full workflow without case assignment', () => {
    const individual = effectiveEntitlements('INDIVIDUAL', [], { maxUsers: 1 }, {});
    const solo = principal(['ORG_ADMIN', 'BROKER'], ['AML_OFFICER', 'APPROVER'], individual);
    expect(can(solo, 'case.create')).toBe(true);
    expect(can(solo, 'case.approve')).toBe(true);
    expect(can(solo, 'case.assign')).toBe(false);
  });
});

describe('entitlements', () => {
  it('applies plan limits and per-organization overrides', () => {
    const individual = effectiveEntitlements('INDIVIDUAL', [], { maxUsers: 1 }, {});
    expect(canAddMember(individual, 0)).toBe(true);
    expect(canAddMember(individual, 1)).toBe(false);

    const pilot = effectiveEntitlements(
      'AGENCY',
      ['MULTI_USER', 'TASK_ASSIGNMENT'],
      { maxUsers: null },
      { addFeatures: ['WHITE_LABEL'], removeFeatures: ['TASK_ASSIGNMENT'], maxUsers: 5 },
    );
    expect([...pilot.features].sort()).toEqual(['MULTI_USER', 'WHITE_LABEL']);
    expect(canAddMember(pilot, 4)).toBe(true);
    expect(canAddMember(pilot, 5)).toBe(false);
  });

  it('treats a null seat limit as unlimited', () => {
    expect(canAddMember(agency, 10_000)).toBe(true);
  });

  it('rejects unknown features instead of silently ignoring them', () => {
    expect(() => effectiveEntitlements('AGENCY', ['TELEPORT'], {}, {})).toThrow();
    expect(() => effectiveEntitlements('AGENCY', [], {}, { addFeatures: ['TELEPORT'] })).toThrow();
  });
});
