import type { HealthResponse } from '@skydra/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '../../feedback';
import { formatDateTime } from '../../format';
import { Field, Hint, Select } from '../../ui';
import type { CaseParty, Run, ScreeningCheck, ScreeningMatch } from './types';

/** Sanctions / PEP / adverse-media checks of the case parties and the broker's review. */
export function ScreeningPanel(props: { caseId: string; parties: CaseParty[]; run: Run }) {
  const { t } = useTranslation();
  const { caseId, parties, run } = props;
  const checks = useQuery({
    queryKey: ['screenings', caseId],
    queryFn: () => api<ScreeningCheck[]>('GET', `/cases/${caseId}/screenings`),
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<HealthResponse>('GET', '/health'),
    staleTime: Infinity,
  });

  // Checks come newest first, so the first one per party is the latest.
  const latest = (casePartyId: string) => checks.data?.find((c) => c.casePartyId === casePartyId);
  const screen = (casePartyId?: string) =>
    run(
      () => api('POST', `/cases/${caseId}/screenings`, casePartyId ? { casePartyId } : {}),
      t('toast.screened'),
    );
  const date = formatDateTime;

  return (
    <section className="stack">
      <div className="page-head">
        <h2>{t('screening.title')}</h2>
        {parties.length > 0 && (
          <button type="button" onClick={() => void screen()}>
            {t('screening.runAll')}
          </button>
        )}
      </div>
      {health.data?.simulatedProviders && (
        <Hint summary={t('common.demoData')}>
          <p className="muted">{t('screening.simulatedHint')}</p>
        </Hint>
      )}
      <ul className="list">
        {parties.map((cp) => {
          const check = latest(cp.id);
          return (
            <li key={cp.id} className="card static">
              <strong>
                {t(`partyRoles.${cp.role}`)}: {cp.party.displayName}
              </strong>
              {!check ? (
                <span className="muted">{t('screening.notScreened')}</span>
              ) : (
                <>
                  <span className="muted">
                    {t('screening.lastCheck', {
                      date: date(check.requestedAt),
                      provider: check.provider,
                    })}
                  </span>
                  {check.status === 'FAILED' && (
                    <span className="error">{t('screening.failed')}</span>
                  )}
                  {check.status === 'COMPLETED' && check.matches.length === 0 && (
                    <span>{t('screening.noMatches')}</span>
                  )}
                  {check.matches.length > 0 && (
                    <span>{t('screening.matches', { count: check.matches.length })}</span>
                  )}
                  {check.matches.map((m) => (
                    <MatchView key={m.id} caseId={caseId} match={m} run={run} />
                  ))}
                </>
              )}
              <div className="actions">
                <button type="button" className="ghost small" onClick={() => void screen(cp.id)}>
                  {t('screening.run')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MatchView({ caseId, match, run }: { caseId: string; match: ScreeningMatch; run: Run }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [decision, setDecision] = useState<'FALSE_POSITIVE' | 'TRUE_POSITIVE' | ''>('');
  const [justification, setJustification] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!decision) return;
    const ok = await confirm({
      title: t('confirm.reviewMatch'),
      body: `${t(`screening.decisions.${decision}`)}. ${t('confirm.irreversible')}`,
      confirmLabel: t('confirm.record'),
    });
    if (!ok) return;
    await run(
      () =>
        api('POST', `/cases/${caseId}/screening-matches/${match.id}/review`, {
          decision,
          justification,
        }),
      t('toast.matchReviewed'),
    );
  }

  const details = Object.entries(match.details).filter(
    ([key, value]) => key !== 'simulated' && value !== null && typeof value !== 'object',
  );

  return (
    <div className="match">
      <strong>
        {match.categories.map((c) => t(`matchCategories.${c}`)).join(', ')} · {match.name}
        {match.score && ` · ${t('screening.score', { score: Number(match.score) })}`}
      </strong>
      {details.map(([key, value]) => (
        <span key={key} className="muted">
          {t(`screening.details.${key}`, { defaultValue: key })}: {String(value)}
        </span>
      ))}
      <span>{t(`screening.reviewStatuses.${match.reviewStatus}`)}</span>
      {match.reviewStatus === 'OPEN' ? (
        <form onSubmit={submit} className="stack">
          <Select
            label={t('screening.decision')}
            name={`decision-${match.id}`}
            options={['FALSE_POSITIVE', 'TRUE_POSITIVE'] as const}
            optionLabel={(v) => t(`screening.decisions.${v}`)}
            value={decision}
            onChange={setDecision}
            emptyLabel=""
          />
          <Field
            label={t('screening.justification')}
            name={`justification-${match.id}`}
            value={justification}
            onChange={setJustification}
          />
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={!decision || justification.trim().length < 10}
            >
              {t('screening.submitReview')}
            </button>
          </div>
        </form>
      ) : (
        match.reviewedAt && (
          <span className="muted">
            {t('screening.reviewedBy', {
              date: formatDateTime(match.reviewedAt),
              justification: match.reviewJustification,
            })}
          </span>
        )
      )}
    </div>
  );
}
