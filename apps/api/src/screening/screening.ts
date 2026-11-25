import { ReviewMatchInput, RunScreeningInput, type ScreeningOrigin } from '@skydra/shared';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { refreshCompliance } from '../cases/cases';
import { type TenantContext, withTenant } from '../database/tenant';
import { NotFoundError, RuleError, translateDbError } from '../domain-errors';
import {
  type ProviderExchange,
  ProviderError,
  type ProviderResult,
  type ScreeningProvider,
  type ScreeningSubject,
} from './provider';

export type ScreeningMatch = {
  id: string;
  externalId: string | null;
  name: string;
  score: string | null;
  categories: string[];
  strength: 'STRONG' | 'WEAK';
  details: Record<string, unknown>;
  reviewStatus: 'OPEN' | 'FALSE_POSITIVE' | 'TRUE_POSITIVE' | 'NOT_RELEVANT';
  reviewJustification: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** The earlier match whose decision was carried to this one (same record found again). */
  carriedFrom: string | null;
};

export type ScreeningCheck = {
  id: string;
  casePartyId: string;
  partyId: string;
  provider: string;
  /** Every source searched (e.g. OPENSANCTIONS, BRAVE); empty for checks before 0014. */
  sources: string[];
  /** MANUAL, AUTOMATIC or MONITORING; null for checks before 0015. */
  origin: ScreeningOrigin | null;
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
    company_code: string | null;
  }>(
    `SELECT cp.id AS case_party_id, p.id AS party_id, p.party_type, p.display_name,
            to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date, p.citizenships,
            p.residence_country, p.registration_country, p.company_code
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
      ...(r.party_type === 'LEGAL' && r.company_code ? { registrationNumber: r.company_code } : {}),
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
  options: { origin?: ScreeningOrigin } = {},
): Promise<{ checkIds: string[]; complianceStatus: string; newMatches: number; failed: number }> {
  const origin = options.origin ?? 'MANUAL';
  const id = z.uuid().parse(caseId);
  const { casePartyId } = RunScreeningInput.parse(input);
  const toScreen = await withTenant(pool, ctx, (c) => targets(c, id, casePartyId));

  const outcomes: {
    target: Target;
    result?: ProviderResult;
    error?: string;
    exchanges: ProviderExchange[];
  }[] = [];
  for (const target of toScreen) {
    try {
      const result = await provider.screen(target.subject);
      outcomes.push({ target, result, exchanges: result.exchanges ?? [] });
    } catch (error) {
      if (error instanceof RuleError) throw error;
      // The failed attempts are evidence too: the check is FAILED, never "no matches".
      outcomes.push({
        target,
        error: 'provider_error',
        exchanges: error instanceof ProviderError ? error.exchanges : [],
      });
      console.error('screening provider failed', error instanceof Error ? error.message : error);
    }
  }

  const sources = [...(provider.sources ?? [provider.mode])];
  return withTenant(pool, ctx, async (client) => {
    const checkIds: string[] = [];
    let newMatches = 0;
    try {
      for (const { target, result, error, exchanges } of outcomes) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO screening_checks (case_id, case_party_id, party_id, provider, sources,
                                         origin, status, subject, provider_reference)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8)
           RETURNING id`,
          [
            id,
            target.casePartyId,
            target.partyId,
            provider.mode,
            sources,
            origin,
            JSON.stringify(target.subject),
            result?.reference ?? null,
          ],
        );
        const checkId = rows[0]!.id;
        for (const x of exchanges)
          await client.query(
            `INSERT INTO screening_requests (check_id, provider, attempt, request, response,
                                             http_status, response_sha256, error, duration_ms,
                                             sent_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              checkId,
              x.provider ?? provider.mode,
              x.attempt,
              JSON.stringify(x.request),
              x.response === null ? null : JSON.stringify(x.response),
              x.httpStatus,
              x.responseSha256,
              x.error,
              x.durationMs,
              x.sentAt,
            ],
          );
        for (const m of result?.matches ?? [])
          await client.query(
            `INSERT INTO screening_matches (check_id, external_id, name, score, strength,
                                            categories, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              checkId,
              m.externalId,
              m.name,
              m.score,
              m.strength,
              m.categories,
              JSON.stringify(m.details),
            ],
          );
        // Strong matches whose decision was not carried from an earlier check: new findings.
        const { rows: fresh } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM screening_matches
            WHERE check_id = $1 AND strength = 'STRONG' AND carried_from IS NULL`,
          [checkId],
        );
        newMatches += fresh[0]!.n;
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
            sources,
            origin,
            status: result ? 'COMPLETED' : 'FAILED',
            matchCount: result?.matches.length ?? null,
            strongMatches: result?.matches.filter((m) => m.strength === 'STRONG').length ?? null,
            attempts: exchanges.length,
            newStrongMatches: fresh[0]!.n,
          },
        });
        checkIds.push(checkId);
      }
    } catch (error) {
      translateDbError(error);
    }
    return {
      checkIds,
      complianceStatus: await refreshCompliance(client, id),
      newMatches,
      failed: outcomes.filter((o) => !o.result).length,
    };
  });
}

/**
 * Screens parties right after they join a case (or after AML is activated), as the client
 * specification requires. The joining itself is already committed: a check that cannot run here
 * (AML does not apply, no provider configured, an unexpected error) is left for the broker's
 * "Tikrinti" and never undoes the change. A provider outage is still recorded as a FAILED check.
 */
export async function autoScreen(
  pool: Pool,
  ctx: TenantContext,
  provider: ScreeningProvider,
  caseId: string,
  casePartyIds?: readonly string[],
): Promise<'SCREENED' | 'SKIPPED'> {
  try {
    const origin = 'AUTOMATIC' as const;
    if (!casePartyIds) await runScreening(pool, ctx, provider, caseId, {}, { origin });
    else
      for (const casePartyId of casePartyIds)
        await runScreening(pool, ctx, provider, caseId, { casePartyId }, { origin });
    return 'SCREENED';
  } catch (error) {
    if (!(error instanceof RuleError))
      console.error('automatic screening failed', error instanceof Error ? error.message : error);
    return 'SKIPPED';
  }
}

/** All checks of a case, newest first, with their matches. */
export async function listScreenings(
  client: PoolClient,
  caseId: string,
): Promise<ScreeningCheck[]> {
  const id = z.uuid().parse(caseId);
  const { rows } = await client.query<ScreeningCheck>(
    `SELECT s.id, s.case_party_id AS "casePartyId", s.party_id AS "partyId", s.provider,
            s.sources, s.origin, s.status,
            s.subject, s.match_count AS "matchCount", s.error, s.legal_regime AS "legalRegime",
            s.requested_by AS "requestedBy", s.requested_at AS "requestedAt",
            s.completed_at AS "completedAt",
            coalesce((
              SELECT json_agg(json_build_object(
                       'id', m.id, 'externalId', m.external_id, 'name', m.name,
                       'score', m.score::text, 'strength', m.strength,
                       'categories', m.categories, 'details', m.details,
                       'reviewStatus', m.review_status,
                       'reviewJustification', m.review_justification,
                       'reviewedBy', m.reviewed_by, 'reviewedAt', m.reviewed_at,
                       'carriedFrom', m.carried_from)
                     ORDER BY m.strength = 'WEAK', m.score DESC NULLS LAST, m.name)
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
 * confirmed; an article may also be not relevant (about the person, but no risk). The
 * justification is mandatory and the decision final; a later check produces new matches to
 * review.
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
  if (decision === 'NOT_RELEVANT' && !found[0].categories.includes('ADVERSE_MEDIA'))
    throw new RuleError('only an article can be marked not relevant');

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
