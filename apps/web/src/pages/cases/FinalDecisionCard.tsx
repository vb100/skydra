import { CLOSING_DECISIONS, type CaseDecision } from '@skydra/shared';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '../../feedback';
import { formatDate, formatDateTime } from '../../format';
import { Field, Select } from '../../ui';
import type { Approval, ChecklistEntry, FinalDecision, Run } from './types';

const APPROVALS: readonly CaseDecision[] = ['APPROVE', 'APPROVE_WITH_ENHANCED_MEASURES'];

/**
 * The broker's final decision (client answer Q25): approve, approve with enhanced measures,
 * decline, or terminate, with the reasons and a separate assessment of suspicious indicators.
 * The rules are the database's; this offers only the choices that can apply.
 */
export function FinalDecisionCard(props: {
  caseId: string;
  decisions: FinalDecision[];
  approvals: Approval[];
  checklist: ChecklistEntry[];
  run: Run;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [decision, setDecision] = useState<CaseDecision | ''>('');
  const [justification, setJustification] = useState('');
  const [suspicion, setSuspicion] = useState<'NO' | 'YES' | ''>('');
  const [notes, setNotes] = useState('');

  const [latest, ...earlier] = props.decisions;
  const closed = !!latest && CLOSING_DECISIONS.includes(latest.decision);
  const failing = props.checklist.filter((e) => !e.ok).map((e) => e.item);
  const decisionMissing = failing.includes('DECISION_RECORDED');
  const ready = failing.every((item) => item === 'DECISION_RECORDED');
  const approvedBefore = props.decisions.some((d) => APPROVALS.includes(d.decision));
  // An approver's EDD approval means enhanced due diligence applied.
  const enhanced = props.approvals.some((a) => a.status === 'APPROVED');
  const canApprove = ready && decisionMissing;
  const options: CaseDecision[] = [
    ...(ready && decisionMissing ? APPROVALS.filter((d) => !(enhanced && d === 'APPROVE')) : []),
    approvedBefore ? 'TERMINATE' : 'DECLINE',
  ];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!decision || !suspicion) return;
    const closes = CLOSING_DECISIONS.includes(decision);
    const ok = await confirm({
      title: t('finalDecision.confirm'),
      body: `${t(`finalDecision.decisions.${decision}`)}. ${
        closes ? t('finalDecision.closesCase') : t('confirm.irreversible')
      }`,
      confirmLabel: t('confirm.record'),
      danger: closes,
    });
    if (!ok) return;
    const done = await props.run(
      () =>
        api('POST', `/cases/${props.caseId}/final-decision`, {
          decision,
          justification,
          suspiciousIndicators: suspicion === 'YES',
          ...(suspicion === 'YES' ? { suspicionNotes: notes } : {}),
        }),
      t('finalDecision.recorded'),
    );
    if (done) {
      setDecision('');
      setJustification('');
      setSuspicion('');
      setNotes('');
    }
  }

  const form = (
    <form onSubmit={submit} className="stack">
      <Select
        label={t('finalDecision.decision')}
        name="finalDecision"
        options={options}
        optionLabel={(v) => t(`finalDecision.decisions.${v}`)}
        value={decision}
        onChange={setDecision}
        emptyLabel=""
        required
      />
      <Field
        label={t('finalDecision.justification')}
        name="finalJustification"
        value={justification}
        onChange={setJustification}
      />
      <Select
        label={t('finalDecision.suspicious')}
        name="suspicion"
        options={['NO', 'YES'] as const}
        optionLabel={(v) =>
          v === 'YES' ? t('finalDecision.suspiciousYes') : t('finalDecision.suspiciousNo')
        }
        value={suspicion}
        onChange={setSuspicion}
        emptyLabel=""
        required
      />
      {suspicion === 'YES' && (
        <>
          <Field
            label={t('finalDecision.suspicionNotes')}
            name="suspicionNotes"
            value={notes}
            onChange={setNotes}
          />
          <span className="muted">{t('finalDecision.suspicionNeedsReport')}</span>
        </>
      )}
      <div className="actions">
        <button
          type="submit"
          className={decision && CLOSING_DECISIONS.includes(decision) ? 'danger' : 'primary'}
          disabled={
            !decision ||
            !suspicion ||
            justification.trim().length < 10 ||
            (suspicion === 'YES' && notes.trim().length < 10)
          }
        >
          {t('finalDecision.submit')}
        </button>
      </div>
    </form>
  );

  return (
    <section className="card static stack">
      <h2>{t('finalDecision.title')}</h2>
      {latest && <DecisionView decision={latest} />}
      {latest && !closed && decisionMissing && APPROVALS.includes(latest.decision) && (
        <div className="banner warn" role="status">
          {t('finalDecision.outdated')}
        </div>
      )}
      {closed ? (
        <p className="muted">{t('finalDecision.closed')}</p>
      ) : (
        <>
          {canApprove && <p className="muted">{t('finalDecision.hint')}</p>}
          {!ready && <p className="muted">{t('finalDecision.notReady')}</p>}
          {canApprove && enhanced && <p className="muted">{t('finalDecision.enhancedRequired')}</p>}
          {canApprove ? (
            form
          ) : (
            // Only declining or terminating is possible now: offered, not pressed on.
            <details className="disclosure">
              <summary>{t(`finalDecision.decisions.${options[0]!}`)}</summary>
              {form}
            </details>
          )}
        </>
      )}

      {earlier.length > 0 && (
        <details className="disclosure">
          <summary>{t('finalDecision.history')}</summary>
          {earlier.map((d) => (
            <DecisionView key={d.id} decision={d} />
          ))}
        </details>
      )}
    </section>
  );
}

function DecisionView({ decision: d }: { decision: FinalDecision }) {
  const { t } = useTranslation();
  return (
    <div className="stack-tight">
      <strong>
        {t('finalDecision.entry', {
          decision: t(`finalDecision.decisions.${d.decision}`),
          by: d.decidedByName,
          date: formatDateTime(d.decidedAt),
        })}
      </strong>
      <span>{d.justification}</span>
      <span className="muted">
        {d.suspiciousIndicators
          ? `${t('finalDecision.suspiciousYes')}: ${d.suspicionNotes ?? ''}`
          : t('finalDecision.suspiciousNo')}
      </span>
      {d.riskLevel && (
        <span className="muted">
          {t('finalDecision.risk', { level: t(`riskLevels.${d.riskLevel}`) })}
          {d.nextReviewOn &&
            ` · ${t('finalDecision.nextReview', { date: formatDate(d.nextReviewOn) })}`}
        </span>
      )}
    </div>
  );
}
