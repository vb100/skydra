import { type HealthResponse, screeningStatus } from '@skydra/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '../../feedback';
import { formatDateTime } from '../../format';
import { Field, Hint, Select } from '../../ui';
import { ScreeningBadge } from './PartyCard';
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
      <p className="muted">{t('screening.autoHint')}</p>
      {health.data?.simulatedProviders && (
        <Hint summary={t('common.demoData')}>
          <p className="muted">{t('screening.simulatedHint')}</p>
        </Hint>
      )}
      <ul className="list">
        {parties.map((cp) => {
          const check = latest(cp.id);
          const own = checks.data?.filter((c) => c.casePartyId === cp.id) ?? [];
          const { status, lastAttemptFailed } = screeningStatus(own);
          return (
            <li key={cp.id} className="card static">
              <span className="screening-head">
                <strong>
                  {t(`partyRoles.${cp.role}`)}: {cp.party.displayName}
                </strong>
                <ScreeningBadge status={status} />
              </span>
              {status === 'RED' && (
                <div className="banner blocked" role="alert">
                  <div className="stack-tight">
                    <strong>{t('screening.redTitle')}</strong>
                    <span>{t('screening.redSteps')}</span>
                  </div>
                </div>
              )}
              {status === 'ORANGE' && (
                <div className="banner warn" role="status">
                  {t('screening.orangeHint')}
                </div>
              )}
              {lastAttemptFailed && check?.status === 'FAILED' && status !== 'FAILED' && (
                <span className="error">{t('screening.lastAttemptFailed')}</span>
              )}
              {!check ? (
                <span className="muted">{t('screening.notScreened')}</span>
              ) : (
                <>
                  <span className="muted">
                    {t('screening.lastCheck', {
                      date: date(check.requestedAt),
                      provider: t(`screening.providers.${check.provider}`, {
                        defaultValue: check.provider,
                      }),
                    })}
                  </span>
                  {check.status === 'FAILED' && status === 'FAILED' && (
                    <span className="error">{t('screening.failed')}</span>
                  )}
                  {check.status === 'COMPLETED' && check.matches.length === 0 && (
                    <span>{t('screening.noMatches')}</span>
                  )}
                  <Matches caseId={caseId} matches={check.matches} run={run} />
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

/** Strong matches first, each to be reviewed; weak ones (below the threshold) folded. */
function Matches(props: { caseId: string; matches: ScreeningMatch[]; run: Run }) {
  const { t } = useTranslation();
  const strong = props.matches.filter((m) => m.strength === 'STRONG');
  const weak = props.matches.filter((m) => m.strength === 'WEAK');
  return (
    <>
      {strong.length > 0 && <span>{t('screening.matches', { count: strong.length })}</span>}
      {strong.map((m) => (
        <MatchView key={m.id} caseId={props.caseId} match={m} run={props.run} />
      ))}
      {weak.length > 0 && (
        <details className="disclosure">
          <summary>{t('screening.weakMatches', { count: weak.length })}</summary>
          <p className="muted">{t('screening.weakHint')}</p>
          {weak.map((m) => (
            <MatchView key={m.id} caseId={props.caseId} match={m} run={props.run} />
          ))}
        </details>
      )}
    </>
  );
}

const isLink = (value: unknown): value is string =>
  typeof value === 'string' && /^https:\/\//.test(value);

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
          {t(`screening.details.${key}`, { defaultValue: key })}:{' '}
          {isLink(value) ? (
            <a href={value} target="_blank" rel="noopener noreferrer">
              {new URL(value).hostname}
            </a>
          ) : (
            String(value)
          )}
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
