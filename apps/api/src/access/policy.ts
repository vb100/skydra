import type { Permission, Role } from '@skydra/shared';
import { type Entitlements, hasFeature } from './entitlements';

/** Who is acting, resolved once per request from the session and the active membership. */
export type Principal = {
  userId: string;
  organizationId: string;
  roles: ReadonlySet<Role>;
  permissions: ReadonlySet<Permission>;
  entitlements: Entitlements;
};

export type Action =
  | 'organization.view'
  | 'organization.update'
  | 'member.view'
  | 'member.manage'
  | 'case.create'
  | 'case.view_own'
  | 'case.view_all'
  | 'case.approve'
  | 'case.assign'
  | 'aml.escalation_handle'
  | 'audit.view';

const has = (p: Principal, role: Role) => p.roles.has(role);
const holds = (p: Principal, permission: Permission) => p.permissions.has(permission);

/**
 * The single place where access decisions are made. Rules follow the client's answers (Q14–Q16):
 * administration is separate from AML work — an ORG_ADMIN manages people and settings but does
 * not see cases unless also BROKER or MANAGER; approval and AML-officer duties are permissions
 * that can be given to any member.
 */
const RULES: Record<Action, (p: Principal) => boolean> = {
  'organization.view': () => true,
  'organization.update': (p) => has(p, 'ORG_ADMIN'),
  'member.view': (p) => has(p, 'ORG_ADMIN') || has(p, 'MANAGER'),
  'member.manage': (p) => has(p, 'ORG_ADMIN'),
  'case.create': (p) => has(p, 'BROKER') || has(p, 'MANAGER'),
  'case.view_own': (p) => has(p, 'BROKER') || has(p, 'MANAGER'),
  'case.view_all': (p) => has(p, 'MANAGER') || holds(p, 'CASE_VIEW_ALL'),
  'case.approve': (p) => holds(p, 'APPROVER'),
  'case.assign': (p) => has(p, 'MANAGER') && hasFeature(p.entitlements, 'TASK_ASSIGNMENT'),
  'aml.escalation_handle': (p) => holds(p, 'AML_OFFICER'),
  'audit.view': (p) => has(p, 'ORG_ADMIN') || has(p, 'MANAGER') || holds(p, 'AML_OFFICER'),
};

export function can(principal: Principal, action: Action): boolean {
  return RULES[action](principal);
}
