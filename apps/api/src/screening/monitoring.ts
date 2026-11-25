import type { Pool } from 'pg';
import { withTenant } from '../database/tenant';
import { RuleError } from '../domain-errors';
import type { ScreeningProvider } from './provider';
import { runScreening } from './screening';

/**
 * Ongoing monitoring (client answer to Q33): parties of open cases are screened again when
 * their latest check is older than the interval. A new strong match puts the case back to
 * "Reikia peržiūros" and shows on the responsible broker's work list; a match found again
 * keeps its earlier decision (migration 0015), so nothing is asked twice.
 *
 * Open case: AML applies and the transaction is neither completed nor terminated. A party whose
 * latest check still has a strong match awaiting review is left until it is reviewed. Each check
 * is made on behalf of the responsible broker (or, when they are no longer an active member,
 * someone with access to all cases), under the same row-level security as their own requests.
 */
export type MonitoringOptions = {
  intervalDays: number;
  /** At most this many parties per run, oldest check first; the rest wait for the next run. */
  batch: number;
  now?: Date;
};

export type MonitoringSummary = {
  organizations: number;
  due: number;
  screened: number;
  /** Checks recorded as FAILED (a provider could not be reached). */
  failed: number;
  newMatches: number;
  /** Not screened: the case no longer allows it, or something unexpected (logged). */
  skipped: number;
  errors: number;
};

type Due = {
  organizationId: string;
  caseId: string;
  casePartyId: string;
  actingUserId: string;
  lastCheckAt: Date | null;
};

const DUE = `
  SELECT c.id AS "caseId", cp.id AS "casePartyId", c.responsible_user_id AS "responsibleUserId",
         last.at AS "lastCheckAt"
    FROM cases c
    JOIN case_parties cp ON cp.case_id = c.id AND cp.removed_at IS NULL
    LEFT JOIN LATERAL (
      SELECT max(s.requested_at) AS at FROM screening_checks s WHERE s.case_party_id = cp.id
    ) last ON true
   WHERE c.aml_applicability <> 'NOT_APPLICABLE_RENT_THRESHOLD'
     AND c.stage NOT IN ('COMPLETED', 'TERMINATED')
     AND coalesce(last.at, '-infinity') < $1
     -- A strong match still awaiting review: the broker is on it, and a new answer that happens
     -- not to contain the record must not make the review task disappear.
     AND NOT EXISTS (
       SELECT 1 FROM screening_matches m
        WHERE m.check_id = (SELECT s.id FROM screening_checks s
                             WHERE s.case_party_id = cp.id AND s.status = 'COMPLETED'
                             ORDER BY s.requested_at DESC LIMIT 1)
          AND m.review_status = 'OPEN' AND m.strength = 'STRONG')
   ORDER BY coalesce(last.at, '-infinity'), cp.id
   LIMIT $2`;

/** Parties due in every organization, oldest check first across all of them. */
export async function findDue(
  pool: Pool,
  screenedBefore: Date,
  limit: number,
): Promise<{ organizations: number; due: Due[] }> {
  const { rows: actors } = await pool.query<{
    organization_id: string;
    user_id: string;
    all_cases: boolean;
  }>('SELECT organization_id, user_id, all_cases FROM app.monitoring_actors()');

  const byOrganization = new Map<string, typeof actors>();
  for (const a of actors)
    byOrganization.set(a.organization_id, [...(byOrganization.get(a.organization_id) ?? []), a]);

  const due = new Map<string, Due>();
  for (const [organizationId, members] of byOrganization) {
    const allCases = members.find((m) => m.all_cases);
    const memberIds = new Set(members.map((m) => m.user_id));
    // One member who sees all cases is enough; otherwise each broker sees their own.
    for (const viewer of allCases ? [allCases] : members) {
      const rows = await withTenant(
        pool,
        { organizationId, userId: viewer.user_id },
        async (c) =>
          (
            await c.query<{
              caseId: string;
              casePartyId: string;
              responsibleUserId: string;
              lastCheckAt: Date | null;
            }>(DUE, [screenedBefore, limit])
          ).rows,
      );
      for (const r of rows)
        due.set(r.casePartyId, {
          organizationId,
          caseId: r.caseId,
          casePartyId: r.casePartyId,
          actingUserId: memberIds.has(r.responsibleUserId) ? r.responsibleUserId : viewer.user_id,
          lastCheckAt: r.lastCheckAt,
        });
    }
  }
  const time = (d: Due) => d.lastCheckAt?.getTime() ?? -Infinity;
  return {
    organizations: byOrganization.size,
    due: [...due.values()].sort((a, b) => time(a) - time(b)).slice(0, limit),
  };
}

export async function runMonitoring(
  pool: Pool,
  provider: ScreeningProvider,
  options: MonitoringOptions,
): Promise<MonitoringSummary> {
  const now = options.now ?? new Date();
  const screenedBefore = new Date(now.getTime() - options.intervalDays * 86_400_000);
  const { organizations, due } = await findDue(pool, screenedBefore, options.batch);

  const summary: MonitoringSummary = {
    organizations,
    due: due.length,
    screened: 0,
    failed: 0,
    newMatches: 0,
    skipped: 0,
    errors: 0,
  };
  for (const d of due) {
    try {
      const result = await runScreening(
        pool,
        { organizationId: d.organizationId, userId: d.actingUserId },
        provider,
        d.caseId,
        { casePartyId: d.casePartyId },
        { origin: 'MONITORING' },
      );
      summary.screened += result.checkIds.length - result.failed;
      summary.failed += result.failed;
      summary.newMatches += result.newMatches;
    } catch (error) {
      // A rule (AML no longer applies, the party was just removed) is not an error of the run.
      if (error instanceof RuleError) summary.skipped++;
      else {
        summary.errors++;
        console.error(
          'monitoring check failed',
          d.casePartyId,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
  return summary;
}
