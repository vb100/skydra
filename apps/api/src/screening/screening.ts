import { ReviewMatchInput, RunScreeningInput } from '@skydra/shared';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { refreshCompliance } from '../cases/cases';
import { type TenantContext, withTenant } from '../database/tenant';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';
import type { ProviderResult, ScreeningProvider, ScreeningSubject } from './provider';

export type ScreeningMatch = {
  id: string;
  externalId: string | null;
  name: string;
  score: string | null;
  categories: string[];
  details: Record<string, unknown>;
  reviewStatus: 'OPEN' | 'FALSE_POSITIVE' | 'TRUE_POSITIVE';
  reviewJustification: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
};

export type ScreeningCheck = {
  id: string;
  casePartyId: string;
  partyId: string;
  provider: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  subject: ScreeningSubject;
  matchCount: number | null;
  error: string | null;
  legalRegime: string;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
  matches: ScreeningMatch[];
};

type Target = { casePartyId: string; partyId: string; subject: ScreeningSubject };

/** Active parties to screen, read under the caller's visibility. */
async function targets(client: PoolClient, caseId: string, casePartyId?: string) {
  const { rows: found } = await client.query<{ aml_applicability: string }>(
    'SELECT aml_applicability FROM cases WHERE id = $1',
    [caseId],
  );
  if (!found[0]) throw new NotFoundError('case not found');
  if (found[0].aml_applicability === 'NOT_APPLICABLE_RENT_THRESHOLD')
    throw new RuleError('AML procedures do not apply to this case; activate them first');

  const { rows } = await client.query<{
    case_party_id: string;
    party_id: string;
    party_type: 'NATURAL' | 'LEGAL';
    display_name: string;
    birth_date: string | null;
    citizenships: string[];
    residence_country: string | null;
    registration_country: string | null;
  }>(
    `SELECT cp.id AS case_party_id, p.id AS party_id, p.party_type, p.display_name,
            to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date, p.citizenships,
            p.residence_country, p.registration_country
       FROM case_parties cp JOIN parties p ON p.id = cp.party_id
      WHERE cp.case_id = $1 AND cp.removed_at IS NULL AND ($2::uuid IS NULL OR cp.id = $2)
      ORDER BY cp.added_at`,
    [caseId, casePartyId ?? null],
  );
  if (casePartyId && rows.length === 0) throw new NotFoundError('case party not found');
  if (rows.length === 0) throw new RuleError('add the parties of the case first');

  // The same party may hold several roles in a case; it is still one person to screen per role
  // link, so each link has its own evidence.
  return rows.map<Target>((r) => ({
    casePartyId: r.case_party_id,
    partyId: r.party_id,
    subject: {
      partyType: r.party_type,
      name: r.display_name,
      birthDate: r.birth_date,
      countries: [
        ...new Set(
          [...r.citizenships, r.residence_country, r.registration_country].filter(
            (c): c is string => !!c,
          ),
        ),
      ],
    },
  }));
}

/**
 * Screens the case parties. The provider is called outside any database transaction (a real
 * provider is a network call); the results are then stored in one transaction together with the
 * audit events and the new compliance status. A provider failure is stored as a FAILED check, so
 * the attempt itself is on record.
 */
export async function runScreening(
  pool: Pool,
  ctx: TenantContext,
  provider: ScreeningProvider,
  caseId: string,
  input: RunScreeningInput,
): Promise<{ checkIds: string[]; complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const { casePartyId } = RunScreeningInput.parse(input);
  const toScreen = await withTenant(pool, ctx, (c) => targets(c, id, casePartyId));

  const outcomes: { target: Target; result?: ProviderResult; error?: string }[] = [];
  for (const target of toScreen) {
    try {
      outcomes.push({ target, result: await provider.screen(target.subject) });
    } catch (error) {
      if (error instanceof RuleError) throw error;
      outcomes.push({ target, error: 'provider_error' });
      console.error('screening provider failed', error);
    }
  }

  return withTenant(pool, ctx, async (client) => {
    const checkIds: string[] = [];
    try {
      for (const { target, result, error } of outcomes) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO screening_checks (case_id, case_party_id, party_id, provider, status,
                                         subject, provider_reference)
           VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)
           RETURNING id`,
          [
            id,
            target.casePartyId,
            target.partyId,
            provider.mode,
            JSON.stringify(target.subject),
            result?.reference ?? null,
          ],
        );
        const checkId = rows[0]!.id;
        for (const m of result?.matches ?? [])
          await client.query(
            `INSERT INTO screening_matches (check_id, external_id, name, score, categories, details)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [checkId, m.externalId, m.name, m.score, m.categories, JSON.stringify(m.details)],
          );
        await client.query(
          `UPDATE screening_checks SET status = $2, match_count = $3, error = $4 WHERE id = $1`,
          result
            ? [checkId, 'COMPLETED', result.matches.length, null]
            : [checkId, 'FAILED', null, error],
        );
        await recordAudit(client, {
          action: 'screening.completed',
          entityType: 'case',
          entityId: id,
          after: {
            checkId,
            casePartyId: target.casePartyId,
            provider: provider.mode,
            status: result ? 'COMPLETED' : 'FAILED',
            matchCount: result?.matches.length ?? null,
          },
        });
        checkIds.push(checkId);
      }
    } catch (error) {
      translateDbError(error);
    }
    return { checkIds, complianceStatus: await refreshCompliance(client, id) };
  });
}

/** All checks of a case, newest first, with their matches. */
export async function listScreenings(
  client: PoolClient,
  caseId: string,
): Promise<ScreeningCheck[]> {
  const id = z.uuid().parse(caseId);
  const { rows } = await client.query<ScreeningCheck>(
    `SELECT s.id, s.case_party_id AS "casePartyId", s.party_id AS "partyId", s.provider, s.status,
            s.subject, s.match_count AS "matchCount", s.error, s.legal_regime AS "legalRegime",
            s.requested_by AS "requestedBy", s.requested_at AS "requestedAt",
            s.completed_at AS "completedAt",
            coalesce((
              SELECT json_agg(json_build_object(
                       'id', m.id, 'externalId', m.external_id, 'name', m.name,
                       'score', m.score::text, 'categories', m.categories, 'details', m.details,
                       'reviewStatus', m.review_status,
                       'reviewJustification', m.review_justification,
                       'reviewedBy', m.reviewed_by, 'reviewedAt', m.reviewed_at)
                     ORDER BY m.score DESC NULLS LAST, m.name)
                FROM screening_matches m WHERE m.check_id = s.id), '[]'::json) AS matches
       FROM screening_checks s
      WHERE s.case_id = $1
      ORDER BY s.requested_at DESC, s.id`,
    [id],
  );
  return rows;
}

/**
 * Records the broker's decision on a potential match: not the same person (false positive) or
 * confirmed. The justification is mandatory and the decision final; a later check produces new
 * matches to review.
 */
export async function reviewMatch(
  client: PoolClient,
  caseId: string,
  matchId: string,
  input: ReviewMatchInput,
): Promise<{ complianceStatus: string }> {
  const id = z.uuid().parse(caseId);
  const mId = z.uuid().parse(matchId);
  const { decision, justification } = ReviewMatchInput.parse(input);

  const { rows: found } = await client.query<{ review_status: string; categories: string[] }>(
    `SELECT m.review_status, m.categories
       FROM screening_matches m JOIN screening_checks s ON s.id = m.check_id
      WHERE m.id = $1 AND s.case_id = $2`,
    [mId, id],
  );
  if (!found[0]) throw new NotFoundError('match not found');
  if (found[0].review_status !== 'OPEN')
    throw new RuleError('this match has already been reviewed');

  await client.query(
    `UPDATE screening_matches SET review_status = $2, review_justification = $3 WHERE id = $1`,
    [mId, decision, justification],
  );
  await recordAudit(client, {
    action: 'screening.match_reviewed',
    entityType: 'case',
    entityId: id,
    before: { matchId: mId, reviewStatus: 'OPEN' },
    after: {
      matchId: mId,
      reviewStatus: decision,
      categories: found[0].categories,
      justification,
    },
  });
  return { complianceStatus: await refreshCompliance(client, id) };
}
