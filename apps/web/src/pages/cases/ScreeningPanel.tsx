import { type HealthResponse, screeningStatus } from '@skydra/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '../../feedback';
import { formatDate, formatDateTime } from '../../format';
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
                    {t(check.origin ? 'screening.lastCheckOrigin' : 'screening.lastCheck', {
                      date: date(check.requestedAt),
                      origin: check.origin && t(`screening.origins.${check.origin}`),
                      provider: (check.sources.length ? check.sources : [check.provider])
                        .map((p) => t(`screening.providers.${p}`, { defaultValue: p }))
                        .join(', '),
                    })}
                  </span>
                  {check.status === 'FAILED' && status === 'FAILED' && (
                    <span className="error">{t('screening.failed')}</span>
                  )}
                  {check.status === 'COMPLETED' && check.matches.length === 0 && (
                    <span>{t('screening.noMatches')}</span>
                  )}
                  <Matches
                    caseId={caseId}
                    matches={check.matches}
                    monitoring={check.origin === 'MONITORING'}
                    run={run}
                  />
                  <EarlierConfirmed own={own} latest={check} />
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

/**
 * Confirmed matches of earlier checks that the latest completed check no longer contains (e.g.
 * the person was delisted): they stay in force, so they stay visible.
 */
function EarlierConfirmed({ own, latest }: { own: ScreeningCheck[]; latest: ScreeningCheck }) {
  const { t } = useTranslation();
  const lastDone = own.find((c) => c.status === 'COMPLETED');
  if (!lastDone || lastDone.id !== latest.id) return null;
  const present = new Set(lastDone.matches.map((m) => m.externalId).filter(Boolean));
  const seen = new Set<string>();
  const earlier = own
    .filter((c) => c.status === 'COMPLETED' && c.id !== lastDone.id)
    .flatMap((c) => c.matches)
    .filter((m) => m.reviewStatus === 'TRUE_POSITIVE')
    .filter((m) => {
      const key = m.externalId ?? m.id;
      if (present.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (earlier.length === 0) return null;
  return (
    <div className="stack-tight">
      <strong>{t('screening.earlierConfirmed')}</strong>
      <span className="muted">{t('screening.earlierConfirmedHint')}</span>
      {earlier.map((m) => (
        <div key={m.id} className="match">
          <strong>
            {m.categories.map((c) => t(`matchCategories.${c}`)).join(', ')} · {m.name}
          </strong>
          {m.reviewedAt && (
            <span className="muted">
              {t('screening.reviewedBy', {
                date: formatDateTime(m.reviewedAt),
                justification: m.reviewJustification,
              })}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Strong matches first, each to be reviewed; weak ones (below the threshold) folded. */
function Matches(props: {
  caseId: string;
  matches: ScreeningMatch[];
  monitoring: boolean;
  run: Run;
}) {
  const { t } = useTranslation();
  const strong = props.matches.filter((m) => m.strength === 'STRONG');
  const weak = props.matches.filter((m) => m.strength === 'WEAK');
  return (
    <>
      {strong.length > 0 && <span>{t('screening.matches', { count: strong.length })}</span>}
      {strong.map((m) => (
        <MatchView
          key={m.id}
          caseId={props.caseId}
          match={m}
          isNew={props.monitoring && !m.carriedFrom}
          run={props.run}
        />
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

const str = (value: unknown) => (typeof value === 'string' && value ? value : null);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The snippet with the name forms and risk words marked (case-insensitive, word starts). */
export function highlight(text: string, terms: readonly string[]): ReactNode[] {
  const usable = terms.filter((term) => term.trim().length >= 3);
  if (usable.length === 0) return [text];
  const pattern = new RegExp(
    `(${[...usable]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|')})`,
    'giu',
  );
  return text
    .split(pattern)
    .map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))
    .filter((part) => part !== '');
}

/** A news or web article found about the person: link, where and when, and the snippet. */
function ArticleHead({ match }: { match: ScreeningMatch }) {
  const { t } = useTranslation();
  const d = match.details;
  const url = isLink(d.sourceUrl) ? d.sourceUrl : null;
  const title = str(d.title) ?? match.name;
  const snippet = str(d.snippet);
  const terms = Array.isArray(d.terms)
    ? d.terms.filter((x): x is string => typeof x === 'string')
    : [];
  const published = str(d.publishedAt);
  return (
    <>
      <strong>
        {t('matchCategories.ADVERSE_MEDIA')} ·{' '}
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {title}
          </a>
        ) : (
          title
        )}
      </strong>
      <span className="muted">
        {[str(d.domain), published && formatDate(published)].filter(Boolean).join(' · ')}
        {str(d.source) && ` · ${t('screening.article.foundIn', { source: d.source })}`}
      </span>
      {snippet && <p className="article-snippet">{highlight(snippet, terms)}</p>}
    </>
  );
}

const LIST_DECISIONS = ['FALSE_POSITIVE', 'TRUE_POSITIVE'] as const;
const ARTICLE_DECISIONS = ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'NOT_RELEVANT'] as const;
type Decision = (typeof ARTICLE_DECISIONS)[number];

function MatchView(props: { caseId: string; match: ScreeningMatch; isNew?: boolean; run: Run }) {
  const { caseId, match, run } = props;
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [decision, setDecision] = useState<Decision | ''>('');
  const [justification, setJustification] = useState('');
  const article = match.details.kind === 'article';
  const decisionKey = article ? 'screening.articleDecisions' : 'screening.decisions';
  const statusKey = article ? 'screening.articleStatuses' : 'screening.reviewStatuses';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!decision) return;
    const ok = await confirm({
      title: t('confirm.reviewMatch'),
      body: `${t(`${decisionKey}.${decision}`)}. ${t('confirm.irreversible')}`,
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
    <div className={props.isNew ? 'match match-new' : 'match'}>
      {props.isNew && <span className="chip chip-new">{t('screening.newInMonitoring')}</span>}
      {article ? (
        <ArticleHead match={match} />
      ) : (
        <>
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
        </>
      )}
      <span>{t(`${statusKey}.${match.reviewStatus}`)}</span>
      {match.carriedFrom && <span className="muted">{t('screening.carried')}</span>}
      {match.reviewStatus === 'OPEN' ? (
        <form onSubmit={submit} className="stack">
          {article && <p className="muted">{t('screening.article.hint')}</p>}
          <Select
            label={t('screening.decision')}
            name={`decision-${match.id}`}
            options={article ? ARTICLE_DECISIONS : LIST_DECISIONS}
            optionLabel={(v) => t(`${decisionKey}.${v}`)}
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
