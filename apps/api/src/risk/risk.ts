import { AssessRiskInput, type RiskLevel } from '@skydra/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { refreshCompliance } from '../cases/cases';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';
import {
  evaluateRisk,
  isBelow,
  nextReviewOn,
  type RiskEvaluation,
  type RiskFacts,
  RuleSetDefinition,
} from './engine';

export type RuleSet = {
  id: string;
  code: string;
  version: string;
  title: string;
  isDemo: boolean;
  definition: RuleSetDefinition;
};

export type RiskAssessment = {
  id: string;
  ruleSetCode: string;
  ruleSetVersion: string;
  isDemo: boolean;
  calculatedLevel: RiskLevel;
  mandatoryLevel: RiskLevel | null;
  finalLevel: RiskLevel;
  justification: string | null;
  factors: RiskEvaluation['factors'];
  nextReviewOn: string;
  assessedBy: string;
  assessedByName: string;
  assessedAt: string;
};

export type RiskOverview = {
  ruleSet: Omit<RuleSet, 'definition'>;
  /** The preliminary result with the case as it is now. */
  preview: RiskEvaluation & { facts: RiskFacts };
  current: RiskAssessment | null;
  /** The current assessment predates a change of its inputs. */
  stale: boolean;
  history: RiskAssessment[];
};

/** The rule set in force: the latest valid version of LT-RISK-01. */
export async function currentRuleSet(client: PoolClient): Promise<RuleSet> {
  const { rows } = await client.query<Omit<RuleSet, 'definition'> & { definition: unknown }>(
    `SELECT id, code, version, title, is_demo AS "isDemo", definition
       FROM risk_rule_sets
      WHERE code = 'LT-RISK-01' AND valid_from <= now()
      ORDER BY valid_from DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) throw new Error('no risk rule set in force');
  // A malformed rule set must fail loudly rather than produce a wrong risk level.
  return { ...r, definition: RuleSetDefinition.parse(r.definition) };
}

/** Facts for the risk rules, read under the caller's visibility. */
export async function gatherFacts(client: PoolClient, caseId: string): Promise<RiskFacts> {
  const { rows: found } = await client.query<{
    transaction_type: string;
    transaction_value: string | null;
    monthly_rent: string | null;
    payment_method: string | null;
  }>(
    'SELECT transaction_type, transaction_value, monthly_rent, payment_method FROM cases WHERE id = $1',
    [caseId],
  );
  const c = found[0];
  if (!c) throw new NotFoundError('case not found');

  const { rows: parties } = await client.query<{
    id: string;
    role: string;
    cdd_scope: string;
    is_our_client: boolean;
    kyc: {
      actsOnOwnBehalf?: boolean | null;
      pepSelfDeclared?: boolean | null;
      sourceOfFunds?: string | null;
    };
    party_type: string;
    citizenships: string[];
    residence_country: string | null;
    registration_country: string | null;
  }>(
    `SELECT cp.id, cp.role, cp.cdd_scope, cp.is_our_client, cp.kyc, p.party_type, p.citizenships,
            p.residence_country, p.registration_country
       FROM case_parties cp JOIN parties p ON p.id = cp.party_id
      WHERE cp.case_id = $1 AND cp.removed_at IS NULL`,
    [caseId],
  );

  // Confirmed matches of the latest completed check per party.
  const { rows: confirmed } = await client.query<{ categories: string[] }>(
    `SELECT m.categories
       FROM screening_matches m
       JOIN (SELECT DISTINCT ON (s.case_party_id) s.id
               FROM screening_checks s JOIN case_parties cp ON cp.id = s.case_party_id
              WHERE s.case_id = $1 AND s.status = 'COMPLETED' AND cp.removed_at IS NULL
              ORDER BY s.case_party_id, s.requested_at DESC) l ON l.id = m.check_id
      WHERE m.review_status = 'TRUE_POSITIVE'`,
    [caseId],
  );
  const categories = new Set(confirmed.flatMap((m) => m.categories));

  // Natural persons identified only remotely (non-face-to-face).
  const { rows: identification } = await client.query<{ remote_only: boolean }>(
    `SELECT bool_and(v.method = 'REMOTE') AS remote_only
       FROM identity_verifications v JOIN case_parties cp ON cp.id = v.case_party_id
      WHERE v.case_id = $1 AND v.status = 'VERIFIED' AND cp.removed_at IS NULL
      GROUP BY v.case_party_id`,
    [caseId],
  );

  // Latest registry data of each legal entity in the case.
  const { rows: ownership } = await client.query<{ complex: boolean }>(
    `SELECT DISTINCT ON (o.case_party_id) (o.depth > 1 OR o.incomplete) AS complex
       FROM ownership_snapshots o JOIN case_parties cp ON cp.id = o.case_party_id
      WHERE o.case_id = $1 AND cp.removed_at IS NULL
      ORDER BY o.case_party_id, o.fetched_at DESC`,
    [caseId],
  );

  const full = parties.filter((p) => p.cdd_scope === 'FULL');
  const value =
    c.transaction_type === 'SALE'
      ? c.transaction_value
      : c.monthly_rent && String(Number(c.monthly_rent) * 12);

  return {
    pep:
      categories.has('PEP') ||
      categories.has('PEP_ASSOCIATE') ||
      parties.some((p) => p.kyc.pepSelfDeclared === true),
    sanctions: categories.has('SANCTIONS'),
    adverseMedia: categories.has('ADVERSE_MEDIA'),
    notOwnBehalf: parties.some((p) => p.kyc.actsOnOwnBehalf === false),
    legalEntityParty: parties.some((p) => p.party_type === 'LEGAL' && p.is_our_client),
    representativeInvolved: parties.some((p) => p.role === 'REPRESENTATIVE'),
    remoteIdentification: identification.some((i) => i.remote_only),
    partyCountries: [
      ...new Set(
        parties.flatMap((p) =>
          [...p.citizenships, p.residence_country, p.registration_country].filter(
            (x): x is string => !!x,
          ),
        ),
      ),
    ].sort(),
    paymentMethod: c.payment_method,
    thirdPartyPayer: parties.some((p) => p.role === 'PAYER'),
    transactionValueEur: value ? Number(value) : null,
    sourceOfFundsMissing: full.some((p) => p.is_our_client && !p.kyc.sourceOfFunds),
    complexOwnership: ownership.some((o) => o.complex),
  };
}

const ASSESSMENTS = `
  SELECT a.id, r.code AS "ruleSetCode", r.version AS "ruleSetVersion", r.is_demo AS "isDemo",
         a.calculated_level AS "calculatedLevel", a.mandatory_level AS "mandatoryLevel",
         a.final_level AS "finalLevel", a.justification, a.factors,
         to_char(a.next_review_on, 'YYYY-MM-DD') AS "nextReviewOn",
         a.assessed_by AS "assessedBy", u.full_name AS "assessedByName",
         a.assessed_at AS "assessedAt"
    FROM risk_assessments a
    JOIN risk_rule_sets r ON r.id = a.rule_set_id
    JOIN users u ON u.id = a.assessed_by
   WHERE a.case_id = $1
   ORDER BY a.assessed_at DESC`;

export async function riskOverview(client: PoolClient, caseId: string): Promise<RiskOverview> {
  const id = z.uuid().parse(caseId);
  const facts = await gatherFacts(client, id);
  const { definition, ...ruleSet } = await currentRuleSet(client);
  const { rows: history } = await client.query<RiskAssessment>(ASSESSMENTS, [id]);
  const { rows: freshness } = await client.query<{ stale: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM risk_assessments
        WHERE case_id = $1 AND assessed_at >= app.case_risk_inputs_changed_at($1)) AS stale`,
    [id],
  );
  return {
    ruleSet,
    preview: { ...evaluateRisk(definition, facts), facts },
    current: history[0] ?? null,
    stale: history.length > 0 && freshness[0]!.stale,
    history,
  };
}

/**
 * Records the risk of a case as it is now. The final level defaults to the calculated one; a
 * different level needs a justification, and lowering it is checked in the database (approver,
 * four-eyes, never below the mandatory minimum).
 */
export async function assessRisk(
  client: PoolClient,
  caseId: string,
  input: AssessRiskInput,
): Promise<{ id: string; finalLevel: RiskLevel; complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const i = AssessRiskInput.parse(input);
  const { rows: applies } = await client.query<{ aml_applicability: string }>(
    'SELECT aml_applicability FROM cases WHERE id = $1',
    [id],
  );
  if (!applies[0]) throw new NotFoundError('case not found');
  if (applies[0].aml_applicability === 'NOT_APPLICABLE_RENT_THRESHOLD')
    throw new RuleError('AML procedures do not apply to this case; activate them first');

  const facts = await gatherFacts(client, id);
  const ruleSet = await currentRuleSet(client);
  const evaluation = evaluateRisk(ruleSet.definition, facts);
  const finalLevel = i.finalLevel ?? evaluation.calculatedLevel;
  if (finalLevel !== evaluation.calculatedLevel && (i.justification ?? '').length < 10)
    throw new RuleError('a different risk level needs a justification');
  if (evaluation.mandatoryLevel && isBelow(finalLevel, evaluation.mandatoryLevel))
    throw new RuleError('the risk level cannot be set below the mandatory minimum');

  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO risk_assessments
         (case_id, rule_set_id, facts, factors, calculated_level, mandatory_level, final_level,
          justification, next_review_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        id,
        ruleSet.id,
        JSON.stringify(facts),
        JSON.stringify(evaluation.factors),
        evaluation.calculatedLevel,
        evaluation.mandatoryLevel,
        finalLevel,
        i.justification || null,
        nextReviewOn(ruleSet.definition, finalLevel, new Date()),
      ],
    );
    const assessmentId = rows[0]!.id;
    await recordAudit(client, {
      action: 'risk.assessed',
      entityType: 'case',
      entityId: id,
      after: {
        assessmentId,
        ruleSet: `${ruleSet.code}/${ruleSet.version}`,
        calculatedLevel: evaluation.calculatedLevel,
        mandatoryLevel: evaluation.mandatoryLevel,
        finalLevel,
        justification: i.justification || null,
        matchedFactors: evaluation.factors.filter((f) => f.matched).map((f) => f.code),
      },
    });
    return { id: assessmentId, finalLevel, complianceStatus: await refreshCompliance(client, id) };
  } catch (error) {
    translateDbError(error);
  }
}
