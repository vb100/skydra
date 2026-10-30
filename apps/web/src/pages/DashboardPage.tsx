import { ComplianceStatus, workBucket } from '@skydra/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDate } from '../format';
import { TAB_OF_ITEM } from './cases/NextStepCard';
import { Avatar } from './cases/PartyCard';
import type { CaseListItem } from './cases/types';
import { caseLink, useCases } from './cases/useCases';
import { Badge, Page } from '../ui';

const DAY = 86_400_000;

/**
 * The organization at a glance for managers: headline numbers, cases by compliance status and by
 * risk, each broker's workload, the oldest open cases and upcoming reviews. Everything is computed
 * from the case list the member can see, so it matches the list and the case pages.
 */
/** The time the page was opened: ages and windows stay stable across re-renders. */
export function useNow(): number {
  const [now] = useState(() => Date.now());
  return now;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const cases = useCases();
  const all = cases.data ?? [];
  const open = all.filter((c) => c.complianceStatus !== 'COMPLETED');
  const inScope = all.filter((c) => c.amlApplicability !== 'NOT_APPLICABLE_RENT_THRESHOLD');
  const count = (f: (c: CaseListItem) => boolean) => all.filter(f).length;

  const kpis: [string, number, string][] = [
    [t('dashboard.kpi.active'), open.length, 'active'],
    [t('dashboard.kpi.review'), count((c) => c.complianceStatus === 'REVIEW_REQUIRED'), 'waiting'],
    [t('dashboard.kpi.blocked'), count((c) => c.complianceStatus === 'BLOCKED'), 'blocked'],
    [t('dashboard.kpi.completed'), count((c) => c.complianceStatus === 'COMPLETED'), 'done'],
  ];

  const byStatus = ComplianceStatus.options.map((s) => ({
    key: s,
    label: t(`complianceStatuses.${s}`),
    value: count((c) => c.complianceStatus === s),
    tone: s.toLowerCase(),
  }));
  const byRisk = [
    ...(['HIGH', 'MEDIUM', 'LOW'] as const).map((l) => ({
      key: l,
      label: t(`riskLevels.${l}`),
      value: inScope.filter((c) => c.riskLevel === l).length,
      tone: `risk-${l.toLowerCase()}`,
    })),
    {
      key: 'NONE',
      label: t('dashboard.notAssessed'),
      value: inScope.filter((c) => !c.riskLevel).length,
      tone: 'not_started',
    },
  ];

  const brokers = [...new Map(all.map((c) => [c.responsibleUserId, c.responsibleName])).entries()]
    .map(([userId, name]) => {
      const theirs = all.filter((c) => c.responsibleUserId === userId);
      const viewer = { userId, canApprove: false, isAmlOfficer: false, solo: false };
      return {
        userId,
        name,
        active: theirs.filter((c) => c.complianceStatus !== 'COMPLETED').length,
        action: theirs.filter((c) => workBucket(c, viewer) === 'action').length,
        blocked: theirs.filter((c) => c.complianceStatus === 'BLOCKED').length,
        done: theirs.filter((c) => c.complianceStatus === 'COMPLETED').length,
      };
    })
    .sort((a, b) => b.active - a.active);
  const maxActive = Math.max(1, ...brokers.map((b) => b.active));

  const now = useNow();
  const oldest = inScope
    .filter((c) => c.complianceStatus !== 'COMPLETED')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, 5);
  const horizon = new Date(now + 90 * DAY).toISOString();
  const reviews = all
    .filter((c) => c.nextReviewOn && c.nextReviewOn <= horizon)
    .sort((a, b) => (a.nextReviewOn ?? '').localeCompare(b.nextReviewOn ?? ''));

  return (
    <Page title={t('dashboard.title')} wide>
      <p className="muted page-lead">{t('dashboard.subtitle')}</p>
      <div className="tiles">
        {kpis.map(([label, value, key]) => (
          <div key={key} className={`tile tile-${key}`}>
            <span className="tile-value">{value}</span>
            <span className="tile-label">{label}</span>
          </div>
        ))}
      </div>

      <div className="dash-grid">
        <section className="card static">
          <h2 className="card-title">{t('dashboard.byStatus')}</h2>
          <Bars rows={byStatus} />
        </section>
        <section className="card static">
          <h2 className="card-title">{t('dashboard.byRisk')}</h2>
          <Bars rows={byRisk} />
        </section>

        <section className="card static span-2">
          <h2 className="card-title">{t('dashboard.workload')}</h2>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>{t('dashboard.broker')}</th>
                <th>{t('dashboard.activeCol')}</th>
                <th className="num">{t('dashboard.actionCol')}</th>
                <th className="num">{t('dashboard.blockedCol')}</th>
                <th className="num">{t('dashboard.doneCol')}</th>
              </tr>
            </thead>
            <tbody>
              {brokers.map((b) => (
                <tr key={b.userId}>
                  <td>
                    <span className="person">
                      <Avatar name={b.name} legal={false} />
                      {b.name}
                    </span>
                  </td>
                  <td>
                    <span className="inline-bar" title={`${b.name}: ${b.active}`}>
                      <span
                        className="inline-bar-fill"
                        style={{ width: `${(b.active / maxActive) * 100}%` }}
                      />
                      <span className="num">{b.active}</span>
                    </span>
                  </td>
                  <td className="num">{b.action}</td>
                  <td className="num">{b.blocked}</td>
                  <td className="num">{b.done}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card static">
          <h2 className="card-title">{t('dashboard.oldest')}</h2>
          {oldest.length === 0 && <p className="muted">{t('dashboard.none')}</p>}
          <ul className="work-list">
            {oldest.map((c) => (
              <li key={c.id}>
                <Link
                  to={caseLink(c.id, c.next ? TAB_OF_ITEM[c.next.item] : undefined)}
                  className="work-row"
                >
                  <span className="work-main">
                    <strong>
                      {c.reference}
                      {c.clientName && ` · ${c.clientName}`}
                    </strong>
                    <span className="muted">
                      {c.next ? t(`checklist.todo.${c.next.item}`) : ''} · {c.responsibleName}
                    </span>
                  </span>
                  <span className="num muted">
                    {t('dashboard.age', {
                      count: Math.max(0, Math.floor((now - Date.parse(c.createdAt)) / DAY)),
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="card static">
          <h2 className="card-title">{t('dashboard.reviews')}</h2>
          {reviews.length === 0 && <p className="muted">{t('dashboard.none')}</p>}
          <ul className="work-list">
            {reviews.map((c) => (
              <li key={c.id}>
                <Link to={caseLink(c.id, 'risk')} className="work-row">
                  <span className="work-main">
                    <strong>
                      {c.reference}
                      {c.clientName && ` · ${c.clientName}`}
                    </strong>
                    <span className="muted">{c.responsibleName}</span>
                  </span>
                  {c.riskLevel && (
                    <Badge kind={`risk-${c.riskLevel}`}>{t(`riskLevels.${c.riskLevel}`)}</Badge>
                  )}
                  <span className="num muted">{formatDate(c.nextReviewOn)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Page>
  );
}

/**
 * Horizontal bars with the label and the number always written next to the bar, so nothing is
 * read from colour alone; status colours carry the state.
 */
function Bars({ rows }: { rows: { key: string; label: string; value: number; tone: string }[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="bars">
      {rows.map((r) => (
        <li key={r.key} title={`${r.label}: ${t('dashboard.casesCount', { count: r.value })}`}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            {r.value > 0 && (
              <span
                className={`bar-fill tone-${r.tone}`}
                style={{ width: `${(r.value / max) * 100}%` }}
              />
            )}
          </span>
          <span className="bar-value num">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}
