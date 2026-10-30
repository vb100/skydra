import { type WorkBucket, workBucket } from '@skydra/shared';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { Me } from '../api';
import { formatDate } from '../format';
import { TAB_OF_ITEM } from './cases/NextStepCard';
import { useNow } from './DashboardPage';
import type { CaseAbilities, CaseListItem } from './cases/types';
import { caseLink, useCases } from './cases/useCases';
import { Badge, Page } from '../ui';

const REVIEW_WINDOW_DAYS = 90;

/**
 * The member's own work, grouped by what it waits for: decisions only they can take first, then
 * their next steps, then what waits for others or is blocked, and upcoming risk reviews.
 */
export function WorkPage({ me, abilities }: { me: Me; abilities: CaseAbilities }) {
  const { t } = useTranslation();
  const cases = useCases();
  const all = cases.data ?? [];
  const viewer = {
    userId: abilities.userId,
    canApprove: abilities.canApprove,
    isAmlOfficer: abilities.isAmlOfficer,
    solo: abilities.solo,
  };
  const bucket = (b: WorkBucket) => all.filter((c) => workBucket(c, viewer) === b);
  const groups = {
    decide: bucket('decide'),
    resolve: bucket('resolve'),
    action: bucket('action'),
    waiting: bucket('waiting'),
    blocked: bucket('blocked'),
  };
  const now = useNow();
  const horizon = new Date(now + REVIEW_WINDOW_DAYS * 86_400_000).toISOString();
  const reviews = all
    .filter(
      (c) =>
        c.responsibleUserId === abilities.userId && c.nextReviewOn && c.nextReviewOn <= horizon,
    )
    .sort((a, b) => (a.nextReviewOn ?? '').localeCompare(b.nextReviewOn ?? ''));
  const mine = all.filter(
    (c) => c.responsibleUserId === abilities.userId && c.complianceStatus !== 'COMPLETED',
  );
  const firstName = me.user.fullName.split(' ')[0];

  const tiles: [string, number, string][] = [
    [t('work.tiles.action'), groups.action.length, 'action'],
    ...(abilities.canApprove || abilities.isAmlOfficer
      ? ([[t('work.tiles.decide'), groups.decide.length + groups.resolve.length, 'decide']] as [
          string,
          number,
          string,
        ][])
      : []),
    [t('work.tiles.waiting'), groups.waiting.length, 'waiting'],
    // Same meaning as the status badge: the member's cases whose transaction cannot proceed.
    [
      t('work.tiles.blocked'),
      mine.filter((c) => c.complianceStatus === 'BLOCKED').length,
      'blocked',
    ],
    [t('work.tiles.active'), mine.length, 'active'],
  ];
  const nothing = Object.values(groups).every((g) => g.length === 0) && reviews.length === 0;

  return (
    <Page
      title={t('work.greeting', { name: firstName })}
      wide
      actions={
        <Link to="/cases" className="button-link">
          {t('work.allCases')}
        </Link>
      }
    >
      <p className="muted page-lead">{t('work.subtitle')}</p>
      <div className="tiles">
        {tiles.map(([label, value, key]) => (
          <div key={key} className={`tile tile-${key}`}>
            <span className="tile-value">{value}</span>
            <span className="tile-label">{label}</span>
          </div>
        ))}
      </div>

      {cases.isSuccess && nothing && <p className="notice">{t('work.empty.all')}</p>}

      <div className="work-grid">
        {groups.decide.length > 0 && (
          <WorkSection title={t('work.sections.decide')} tone="decide">
            {groups.decide.map((c) => (
              <WorkRow key={c.id} c={c} text={t('work.decideHint')} tab="decisions" />
            ))}
          </WorkSection>
        )}
        {groups.resolve.length > 0 && (
          <WorkSection title={t('work.sections.resolve')} tone="blocked">
            {groups.resolve.map((c) => (
              <WorkRow key={c.id} c={c} text={t('work.resolveHint')} tab="decisions" />
            ))}
          </WorkSection>
        )}
        <WorkSection title={t('work.sections.action')} tone="action">
          {groups.action.length === 0 && <p className="muted">{t('work.empty.action')}</p>}
          {groups.action.map((c) => (
            <WorkRow key={c.id} c={c} />
          ))}
        </WorkSection>
        {groups.waiting.length > 0 && (
          <WorkSection title={t('work.sections.waiting')} tone="waiting">
            {groups.waiting.map((c) => (
              <WorkRow
                key={c.id}
                c={c}
                text={
                  c.escalation === 'OPEN' ? t('work.waitingEscalation') : t('work.waitingApproval')
                }
                tab="decisions"
              />
            ))}
          </WorkSection>
        )}
        {groups.blocked.length > 0 && (
          <WorkSection title={t('work.sections.blocked')} tone="blocked">
            {groups.blocked.map((c) => (
              <WorkRow key={c.id} c={c} tab="decisions" />
            ))}
          </WorkSection>
        )}
        {reviews.length > 0 && (
          <WorkSection title={t('work.sections.reviews')} tone="waiting">
            {reviews.map((c) => (
              <WorkRow
                key={c.id}
                c={c}
                text={t('work.reviewOn', { date: formatDate(c.nextReviewOn) })}
                tab="risk"
              />
            ))}
          </WorkSection>
        )}
      </div>
    </Page>
  );
}

function WorkSection(props: { title: string; tone: string; children: ReactNode }) {
  return (
    <section className={`card static work-section work-${props.tone}`}>
      <h2 className="card-title">{props.title}</h2>
      <ul className="work-list">{props.children}</ul>
    </section>
  );
}

/** One case in a work list: what it is, what it needs, where to go. */
function WorkRow({ c, text, tab }: { c: CaseListItem; text?: string; tab?: string }) {
  const { t } = useTranslation();
  const what =
    text ??
    (c.next
      ? `${t(`checklist.todo.${c.next.item}`)}${c.next.partyName ? ` · ${c.next.partyName}` : ''}`
      : '');
  return (
    <li>
      <Link
        to={caseLink(c.id, tab ?? (c.next ? TAB_OF_ITEM[c.next.item] : undefined))}
        className="work-row"
      >
        <span className="work-main">
          <strong>
            {c.reference}
            {c.clientName && ` · ${c.clientName}`}
          </strong>
          <span className="muted">{what}</span>
        </span>
        <span className="badges">
          {c.riskLevel && (
            <Badge kind={`risk-${c.riskLevel}`}>{t(`riskLevels.${c.riskLevel}`)}</Badge>
          )}
          <Badge kind={c.complianceStatus}>{t(`complianceStatuses.${c.complianceStatus}`)}</Badge>
        </span>
        <span className="chevron" aria-hidden="true">
          →
        </span>
      </Link>
    </li>
  );
}
