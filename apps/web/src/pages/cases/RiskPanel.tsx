import { RiskLevel } from '@skydra/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '../../feedback';
import { formatDate } from '../../format';
import { Field, Hint, Select } from '../../ui';
import type { RiskFactor, RiskOverview, Run } from './types';

/** LT-RISK-01: the preliminary result from current data, the recorded assessment and history. */
export function RiskPanel({ caseId, run }: { caseId: string; run: Run }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const risk = useQuery({
    queryKey: ['risk', caseId],
    queryFn: () => api<RiskOverview>('GET', `/cases/${caseId}/risk`),
  });
  const [finalLevel, setFinalLevel] = useState<RiskLevel | ''>('');
  const [justification, setJustification] = useState('');

  const r = risk.data;
  if (!r) return null;
  const { preview, current } = r;
  const differs = finalLevel !== '' && finalLevel !== preview.calculatedLevel;
  const date = formatDate;

  async function assess(e: FormEvent) {
    e.preventDefault();
    const level = t(`riskLevels.${finalLevel || preview.calculatedLevel}`);
    const ok = await confirm({
      title: t('confirm.assessRisk', { level }),
      body: t('confirm.irreversible'),
      confirmLabel: t('confirm.record'),
    });
    if (!ok) return;
    const done = await run(
      () =>
        api('POST', `/cases/${caseId}/risk-assessments`, {
          ...(finalLevel ? { finalLevel } : {}),
          ...(differs ? { justification } : {}),
        }),
      t('toast.riskAssessed'),
    );
    if (done) {
      setFinalLevel('');
      setJustification('');
    }
  }

  return (
    <section className="card static stack">
      <h2>{t('risk.title')}</h2>
      <span className="muted">
        {t('risk.methodology', { code: r.ruleSet.code, version: r.ruleSet.version })}
      </span>
      {r.ruleSet.isDemo && (
        <Hint summary={t('common.demoData')}>
          <p className="muted">{t('risk.demo')}</p>
        </Hint>
      )}

      <div className="match">
        <strong>
          {t('risk.current')}: {current ? <Level level={current.finalLevel} /> : t('risk.none')}
        </strong>
        {current && (
          <>
            <span className="muted">
              {t('risk.entry', {
                level: t(`riskLevels.${current.finalLevel}`),
                date: date(current.assessedAt),
                by: current.assessedByName,
              })}
              {current.finalLevel !== current.calculatedLevel &&
                ` (${t('risk.calculatedWas', { level: t(`riskLevels.${current.calculatedLevel}`) })})`}
            </span>
            {current.justification && <span className="muted">{current.justification}</span>}
            <span>{t('risk.nextReview', { date: date(current.nextReviewOn) })}</span>
          </>
        )}
        {r.stale && <span className="error">{t('risk.stale')}</span>}
      </div>

      <div className="match">
        <strong>
          {t('risk.preliminary')}: <Level level={preview.calculatedLevel} />
        </strong>
        {preview.mandatoryLevel && (
          <span>{t('risk.mandatory', { level: t(`riskLevels.${preview.mandatoryLevel}`) })}</span>
        )}
        {preview.escalatedByMediumCount && <span>{t('risk.mediumEscalation')}</span>}
        <Factors factors={preview.factors} />
      </div>

      <form onSubmit={assess} className="stack">
        <Select
          label={t('risk.finalLevel')}
          name="finalLevel"
          options={RiskLevel.options}
          optionLabel={(v) => t(`riskLevels.${v}`)}
          value={finalLevel}
          onChange={setFinalLevel}
          emptyLabel={`${t('risk.asCalculated')} (${t(`riskLevels.${preview.calculatedLevel}`)})`}
        />
        {differs && (
          <>
            <Field
              label={t('risk.justification')}
              name="riskJustification"
              value={justification}
              onChange={setJustification}
            />
            <small className="muted">{t('risk.lowerHint')}</small>
          </>
        )}
        <div className="actions">
          <button
            type="submit"
            className={r.stale || !current ? 'primary' : undefined}
            disabled={differs && justification.trim().length < 10}
          >
            {t('risk.assess')}
          </button>
        </div>
      </form>

      {r.history.length > 1 && (
        <details>
          <summary>{t('risk.history')}</summary>
          <ul className="checklist">
            {r.history.slice(1).map((a) => (
              <li key={a.id}>
                {t('risk.entry', {
                  level: t(`riskLevels.${a.finalLevel}`),
                  date: date(a.assessedAt),
                  by: a.assessedByName,
                })}{' '}
                <span className="muted">
                  {a.ruleSetCode}/{a.ruleSetVersion}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function Level({ level }: { level: string }) {
  const { t } = useTranslation();
  return <span className={`level level-${level.toLowerCase()}`}>{t(`riskLevels.${level}`)}</span>;
}

function Factors({ factors }: { factors: RiskFactor[] }) {
  const { t } = useTranslation();
  const matched = factors.filter((f) => f.matched);
  if (matched.length === 0) return <span className="muted">{t('risk.noFactors')}</span>;
  return (
    <ul className="checklist">
      {matched.map((f) => (
        <li key={f.code}>
          <Level level={f.level} /> {t(`riskFactors.${f.code}`, { defaultValue: f.code })}{' '}
          <span className="muted">· {t(`riskGroups.${f.group}`)}</span>
        </li>
      ))}
    </ul>
  );
}
