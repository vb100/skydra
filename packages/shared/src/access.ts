import { z } from 'zod';

/** Base roles inside an organization. A member can hold several (a solo broker is ORG_ADMIN + BROKER). */
export const Role = z.enum(['ORG_ADMIN', 'MANAGER', 'BROKER']);
export type Role = z.infer<typeof Role>;

/** Responsibilities granted on top of a role, independently of the job title. */
export const Permission = z.enum(['AML_OFFICER', 'APPROVER', 'CASE_VIEW_ALL']);
export type Permission = z.infer<typeof Permission>;

export const PlanCode = z.enum(['INDIVIDUAL', 'AGENCY', 'AGENCY_PRO']);
export type PlanCode = z.infer<typeof PlanCode>;

/** Organization-management capabilities that differ by plan. AML/CFT functions never do. */
export const Feature = z.enum([
  'MULTI_USER',
  'TASK_ASSIGNMENT',
  'APPROVAL_WORKFLOW',
  'TEAMS',
  'CUSTOM_RISK_RULES',
  'API_ACCESS',
  'ENTERPRISE_SSO',
  'CUSTOM_WORKFLOW',
  'MULTI_UNIT_OVERSIGHT',
  'PRIORITY_SUPPORT',
  'WHITE_LABEL',
]);
export type Feature = z.infer<typeof Feature>;

/** E-mail as stored and compared everywhere: trimmed and lower-case, validated after normalizing. */
export const Email = z.string().trim().toLowerCase().pipe(z.email());

/**
 * The agency's details shown in the case export (client answer Q43). An empty field clears it.
 */
export const OrganizationProfileInput = z.object({
  name: z.string().trim().min(1).max(200),
  companyCode: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{5,20}$/)
    .or(z.literal('')),
  address: z.string().trim().max(300),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{5,30}$/)
    .or(z.literal('')),
  email: z.email().max(254).or(z.literal('')),
  website: z
    .url({ protocol: /^https$/ })
    .max(300)
    .or(z.literal('')),
});
export type OrganizationProfileInput = z.input<typeof OrganizationProfileInput>;

/** PNG or JPEG (what the PDF can embed), up to 1 MB. */
export const MAX_LOGO_BYTES = 1024 * 1024;
