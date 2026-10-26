import { RiskGroup, RiskLevel } from '@skydra/shared';
import { z } from 'zod';

/** Facts about a case that rules can refer to (gathered by risk.ts from the case data). */
export type RiskFacts = {
  pep: boolean;
  sanctions: boolean;
  adverseMedia: boolean;
  notOwnBehalf: boolean;
  legalEntityParty: boolean;
  representativeInvolved: boolean;
  remoteIdentification: boolean;
  partyCountries: string[];
  paymentMethod: string | null;
  thirdPartyPayer: boolean;
  transactionValueEur: number | null;
  sourceOfFundsMissing: boolean;
};

const FactName = z.enum([
  'pep',
  'sanctions',
  'adverseMedia',
  'notOwnBehalf',
  'legalEntityParty',
  'representativeInvolved',
  'remoteIdentification',
  'partyCountries',
  'paymentMethod',
  'thirdPartyPayer',
  'transactionValueEur',
  'sourceOfFundsMissing',
]);

/** One factor: a condition on a fact and the level it sets when the condition holds. */
const Factor = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    group: RiskGroup,
    fact: FactName,
    level: RiskLevel,
    /** A mandatory factor sets a minimum that no one may lower. */
    mandatory: z.boolean().default(false),
    is: z.union([z.boolean(), z.string()]).optional(),
    in: z.array(z.string()).optional(),
    gte: z.number().optional(),
    anyInList: z.string().optional(),
    anyNotInList: z.string().optional(),
  })
  .refine(
    (f) =>
      [f.is, f.in, f.gte, f.anyInList, f.anyNotInList].filter((c) => c !== undefined).length === 1,
    'a factor has exactly one condition',
  );

export const RuleSetDefinition = z
  .object({
    factors: z.array(Factor).min(1),
    aggregation: z.object({
      /** This many MEDIUM factors together make the overall risk HIGH. */
      mediumCountForHigh: z.number().int().positive(),
    }),
    reviewIntervalMonths: z.record(RiskLevel, z.number().int().positive()),
    eddLevels: z.array(RiskLevel),
    lists: z.record(z.string(), z.array(z.string())),
  })
  .superRefine((d, ctx) => {
    for (const f of d.factors)
      for (const list of [f.anyInList, f.anyNotInList])
        if (list !== undefined && !d.lists[list])
          ctx.addIssue({ code: 'custom', message: `unknown list ${list} in factor ${f.code}` });
  });
export type RuleSetDefinition = z.infer<typeof RuleSetDefinition>;

export type FactorResult = {
  code: string;
  group: RiskGroup;
  level: RiskLevel;
  mandatory: boolean;
  matched: boolean;
};

export type RiskEvaluation = {
  calculatedLevel: RiskLevel;
  mandatoryLevel: RiskLevel | null;
  factors: FactorResult[];
  /** Why the overall level is what it is, e.g. three MEDIUM factors. */
  escalatedByMediumCount: boolean;
};

const RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel => (RANK[a] >= RANK[b] ? a : b);
export const isBelow = (a: RiskLevel, b: RiskLevel) => RANK[a] < RANK[b];

function holds(
  factor: z.infer<typeof Factor>,
  facts: RiskFacts,
  lists: RuleSetDefinition['lists'],
) {
  const value = facts[factor.fact];
  if (factor.is !== undefined) return value === factor.is;
  if (factor.in !== undefined) return typeof value === 'string' && factor.in.includes(value);
  if (factor.gte !== undefined) return typeof value === 'number' && value >= factor.gte;
  const values = Array.isArray(value) ? value : [];
  if (factor.anyInList !== undefined)
    return values.some((v) => lists[factor.anyInList!]!.includes(v));
  if (factor.anyNotInList !== undefined)
    return values.some((v) => !lists[factor.anyNotInList!]!.includes(v));
  return false;
}

/**
 * Applies a rule set to the facts. Without matching factors the risk is LOW; otherwise the highest
 * matched level, raised to HIGH when enough MEDIUM factors coincide. Pure, so it is tested
 * directly and gives the same answer for the preview and the recorded assessment.
 */
export function evaluateRisk(definition: RuleSetDefinition, facts: RiskFacts): RiskEvaluation {
  const factors = definition.factors.map((f) => ({
    code: f.code,
    group: f.group,
    level: f.level,
    mandatory: f.mandatory,
    matched: holds(f, facts, definition.lists),
  }));
  const matched = factors.filter((f) => f.matched);

  let level: RiskLevel = matched.reduce<RiskLevel>((acc, f) => maxLevel(acc, f.level), 'LOW');
  const mediumCount = matched.filter((f) => f.level === 'MEDIUM').length;
  const escalatedByMediumCount =
    level !== 'HIGH' && mediumCount >= definition.aggregation.mediumCountForHigh;
  if (escalatedByMediumCount) level = 'HIGH';

  const mandatory = matched.filter((f) => f.mandatory);
  const mandatoryLevel = mandatory.length
    ? mandatory.reduce<RiskLevel>((acc, f) => maxLevel(acc, f.level), 'LOW')
    : null;

  return { calculatedLevel: level, mandatoryLevel, factors, escalatedByMediumCount };
}

/** Next review date for a level (months from the assessment date), as an ISO date. */
export function nextReviewOn(definition: RuleSetDefinition, level: RiskLevel, from: Date): string {
  const months = definition.reviewIntervalMonths[level];
  if (!months) throw new Error(`no review interval for ${level}`);
  const d = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, from.getUTCDate()),
  );
  return d.toISOString().slice(0, 10);
}
