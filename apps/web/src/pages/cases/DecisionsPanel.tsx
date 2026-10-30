import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '../../feedback';
import { Field, Select } from '../../ui';
import type { Approval, CaseAbilities, ChecklistEntry, Escalation, Run } from './types';

/** Approval after a confirmed PEP / adverse-media match, and escalations to the AML officer. */
export function DecisionsPanel(props: { caseId: string; abilities: CaseAbilities; run: Run }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
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
  const failing = (item: string) => !!checklist.data?.some((e) => e.item === item && !e.ok);
  // Confirmed sanctions stop the transaction: there is nothing for an approver to approve.
  const sanctioned = failing('NO_CONFIRMED_SANCTIONS');
  const needsApproval = failing('EDD_APPROVED') && !sanctioned;
  const openApproval = approvals.find((a) => a.status === 'OPEN');

  async function requestApproval(e: FormEvent) {
    e.preventDefault();
    const ok = await confirm({
      title: t('confirm.requestApproval'),
      confirmLabel: t('confirm.send'),
    });
    if (
      ok &&
      (await run(
        () => api('POST', `/cases/${caseId}/approvals`, { reason: approvalReason }),
        t('toast.approvalRequested'),
      ))
    )
      setApprovalReason('');
  }

  async function raise(e: FormEvent) {
    e.preventDefault();
    const ok = await confirm({
      title: t('confirm.escalate'),
      body: t('confirm.escalateBody'),
      confirmLabel: t('confirm.send'),
      danger: true,
    });
    if (
      ok &&
      (await run(
        () => api('POST', `/cases/${caseId}/escalations`, { reason: escalationReason }),
        t('toast.escalated'),
      ))
    )
      setEscalationReason('');
  }

  return (
    <>
      {sanctioned && (
        <section className="card static stack">
          <h2>{t('approvals.title')}</h2>
          <div className="banner blocked" role="alert">
            {t('approvals.sanctionsBlocked')}
          </div>
        </section>
      )}
      {!sanctioned && (needsApproval || approvals.length > 0) && (
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
              <div className="actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={approvalReason.trim().length < 10}
                >
                  {t('approvals.request')}
                </button>
              </div>
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
                  confirmTitle={(decision) =>
                    t('confirm.decideApproval', {
                      decision: t(`approvals.decisions.${decision}`),
                    })
                  }
                  onSubmit={(decision, justification) =>
                    run(
                      () =>
                        api('POST', `/cases/${caseId}/approvals/${a.id}/decide`, {
                          decision,
                          justification,
                        }),
                      t('toast.approvalDecided'),
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
                confirmTitle={(resolution) =>
                  t('confirm.resolveEscalation', {
                    resolution: t(`escalations.resolutions.${resolution}`),
                  })
                }
                onSubmit={(resolution, notes) =>
                  run(
                    () =>
                      api('POST', `/cases/${caseId}/escalations/${e.id}/resolve`, {
                        resolution,
                        notes,
                      }),
                    t('toast.escalationResolved'),
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
          <div className="actions">
            <button type="submit" className="danger" disabled={escalationReason.trim().length < 10}>
              {t('escalations.raise')}
            </button>
          </div>
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
  confirmTitle: (choice: T) => string;
  onSubmit: (choice: T, text: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [choice, setChoice] = useState<T | ''>('');
  const [text, setText] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!choice) return;
    const ok = await confirm({
      title: props.confirmTitle(choice),
      body: t('confirm.irreversible'),
      confirmLabel: t('confirm.record'),
    });
    if (ok) await props.onSubmit(choice, text);
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
      <div className="actions">
        <button type="submit" className="primary" disabled={!choice || text.trim().length < 10}>
          {props.submit}
        </button>
      </div>
    </form>
  );
}
