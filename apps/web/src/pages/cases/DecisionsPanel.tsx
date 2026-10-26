import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { Field, Select } from '../../ui';
import type { Approval, CaseAbilities, ChecklistEntry, Escalation } from './types';

type Run = (action: () => Promise<unknown>) => Promise<void>;

/** Approval after a confirmed PEP / adverse-media match, and escalations to the AML officer. */
export function DecisionsPanel(props: { caseId: string; abilities: CaseAbilities; run: Run }) {
  const { t } = useTranslation();
  const { caseId, abilities, run } = props;
  const decisions = useQuery({
    queryKey: ['decisions', caseId],
    queryFn: () =>
      api<{ approvals: Approval[]; escalations: Escalation[] }>(
        'GET',
        `/cases/${caseId}/decisions`,
      ),
  });
  const checklist = useQuery({
    queryKey: ['checklist', caseId],
    queryFn: () => api<ChecklistEntry[]>('GET', `/cases/${caseId}/checklist`),
  });
  const [approvalReason, setApprovalReason] = useState('');
  const [escalationReason, setEscalationReason] = useState('');

  const approvals = decisions.data?.approvals ?? [];
  const escalations = decisions.data?.escalations ?? [];
  const needsApproval = checklist.data?.some((e) => e.item === 'EDD_APPROVED' && !e.ok);
  const openApproval = approvals.find((a) => a.status === 'OPEN');

  async function requestApproval(e: FormEvent) {
    e.preventDefault();
    await run(() => api('POST', `/cases/${caseId}/approvals`, { reason: approvalReason }));
    setApprovalReason('');
  }

  async function raise(e: FormEvent) {
    e.preventDefault();
    await run(() => api('POST', `/cases/${caseId}/escalations`, { reason: escalationReason }));
    setEscalationReason('');
  }

  return (
    <>
      {(needsApproval || approvals.length > 0) && (
        <section className="card static stack">
          <h2>{t('approvals.title')}</h2>
          {needsApproval && !openApproval && (
            <form onSubmit={requestApproval} className="stack">
              <p className="muted">{t('approvals.needed')}</p>
              <Field
                label={t('approvals.reason')}
                name="approvalReason"
                value={approvalReason}
                onChange={setApprovalReason}
              />
              <button type="submit" disabled={approvalReason.trim().length < 10}>
                {t('approvals.request')}
              </button>
            </form>
          )}
          {approvals.map((a) => (
            <div key={a.id} className="match">
              <span>
                {t('approvals.entry', {
                  status: t(`approvals.statuses.${a.status}`),
                  reason: a.reason,
                  by: a.requestedByName,
                })}
              </span>
              {a.decidedByName && (
                <span className="muted">
                  {t('approvals.decided', {
                    by: a.decidedByName,
                    justification: a.decisionJustification,
                  })}
                </span>
              )}
              {a.status === 'OPEN' && abilities.canApprove && (
                <DecisionForm
                  name={`approval-${a.id}`}
                  options={['APPROVED', 'REJECTED'] as const}
                  optionLabel={(v) => t(`approvals.decisions.${v}`)}
                  label={t('approvals.decision')}
                  textLabel={t('approvals.justification')}
                  submit={t('approvals.decide')}
                  onSubmit={(decision, justification) =>
                    run(() =>
                      api('POST', `/cases/${caseId}/approvals/${a.id}/decide`, {
                        decision,
                        justification,
                      }),
                    )
                  }
                />
              )}
            </div>
          ))}
        </section>
      )}

      <section className="card static stack">
        <h2>{t('escalations.title')}</h2>
        {escalations.map((e) => (
          <div key={e.id} className="match">
            <span>
              {t('escalations.entry', {
                status: t(`escalations.statuses.${e.status}`),
                reason: e.reason,
                by: e.requestedByName,
              })}
            </span>
            {e.resolvedByName && (
              <span className="muted">
                {t('escalations.resolved', { by: e.resolvedByName, notes: e.resolutionNotes })}
              </span>
            )}
            {e.status === 'OPEN' && abilities.isAmlOfficer && (
              <DecisionForm
                name={`escalation-${e.id}`}
                options={['CLEARED', 'REPORTED'] as const}
                optionLabel={(v) => t(`escalations.resolutions.${v}`)}
                label={t('escalations.resolution')}
                textLabel={t('escalations.notes')}
                submit={t('escalations.resolve')}
                onSubmit={(resolution, notes) =>
                  run(() =>
                    api('POST', `/cases/${caseId}/escalations/${e.id}/resolve`, {
                      resolution,
                      notes,
                    }),
                  )
                }
              />
            )}
          </div>
        ))}
        <form onSubmit={raise} className="stack">
          <Field
            label={t('escalations.reason')}
            name="escalationReason"
            value={escalationReason}
            onChange={setEscalationReason}
            hint={t('escalations.raiseHint')}
          />
          <button
            type="submit"
            className="secondary"
            disabled={escalationReason.trim().length < 10}
          >
            {t('escalations.raise')}
          </button>
        </form>
      </section>
    </>
  );
}

function DecisionForm<T extends string>(props: {
  name: string;
  options: readonly T[];
  optionLabel: (v: T) => string;
  label: string;
  textLabel: string;
  submit: string;
  onSubmit: (choice: T, text: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState<T | ''>('');
  const [text, setText] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (choice) await props.onSubmit(choice, text);
  }
  return (
    <form onSubmit={submit} className="stack">
      <Select
        label={props.label}
        name={`${props.name}-choice`}
        options={props.options}
        optionLabel={props.optionLabel}
        value={choice}
        onChange={setChoice}
        emptyLabel=""
      />
      <Field label={props.textLabel} name={`${props.name}-text`} value={text} onChange={setText} />
      <button type="submit" disabled={!choice || text.trim().length < 10}>
        {props.submit}
      </button>
    </form>
  );
}
