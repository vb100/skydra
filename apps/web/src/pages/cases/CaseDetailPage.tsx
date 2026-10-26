import { CaseStage, CddStatus } from '@skydra/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { api } from '../../api';
import { useErrorMessage } from '../../session';
import { ErrorText, Field, Page, Select } from '../../ui';
import { AddPartyForm } from './AddPartyForm';
import type { CaseDetail } from './types';

export function CaseDetailPage({ canAssign }: { canAssign: boolean }) {
  const { t, i18n } = useTranslation();
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const errorMessage = useErrorMessage();
  const detail = useQuery({
    queryKey: ['case', id],
    queryFn: () => api<CaseDetail>('GET', `/cases/${id}`),
    retry: false,
  });
  const assignees = useQuery({
    queryKey: ['assignees'],
    queryFn: () => api<{ userId: string; fullName: string }[]>('GET', '/cases/assignees'),
    enabled: canAssign,
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['case', id] }),
      queryClient.invalidateQueries({ queryKey: ['cases'] }),
    ]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const c = detail.data;
  if (detail.error)
    return (
      <Page title={t('cases.title')}>
        <Link to="/cases">{t('common.back')}</Link>
        <ErrorText message={errorMessage(detail.error)} />
      </Page>
    );
  if (!c) return <Page title={t('common.loading')}>{null}</Page>;

  const money = (v: string | null) =>
    v === null ? '' : `${Number(v).toLocaleString(i18n.language)} EUR`;

  async function activate(e: FormEvent) {
    e.preventDefault();
    await run(() => api('POST', `/cases/${id}/activate-aml`, { reason }));
    setReason('');
  }

  return (
    <Page title={`${c.reference} · ${t(`transactionTypes.${c.transactionType}`)}`}>
      <Link to="/cases">{t('common.back')}</Link>
      <ErrorText message={error} />
      <section className="card static">
        <dl className="facts">
          <dt>{t('cases.propertyAddress')}</dt>
          <dd>{c.propertyAddress}</dd>
          <dt>{t('cases.propertyType')}</dt>
          <dd>{t(`propertyTypes.${c.propertyType}`)}</dd>
          <dt>
            {c.transactionType === 'SALE' ? t('cases.transactionValue') : t('cases.monthlyRent')}
          </dt>
          <dd>{money(c.transactionType === 'SALE' ? c.transactionValue : c.monthlyRent)}</dd>
          <dt>{t('cases.paymentMethod')}</dt>
          <dd>
            {c.paymentMethod
              ? `${t(`paymentMethods.${c.paymentMethod}`)}${c.paymentMethodOther ? `: ${c.paymentMethodOther}` : ''}`
              : t('cases.notSpecified')}
          </dd>
          <dt>{t('cases.aml')}</dt>
          <dd>
            {t(`amlApplicability.${c.amlApplicability}`)}
            {c.amlActivationReason && <span className="muted"> ({c.amlActivationReason})</span>}
          </dd>
          <dt>{t('cases.compliance')}</dt>
          <dd>{t(`complianceStatuses.${c.complianceStatus}`)}</dd>
          <dt>{t('cases.legalRegime')}</dt>
          <dd>{t(`legalRegimes.${c.legalRegime}`)}</dd>
          <dt>{t('cases.responsible')}</dt>
          <dd>{c.responsibleName}</dd>
          {c.offerAcceptedAt && (
            <>
              <dt>{t('cases.offerAcceptedAt')}</dt>
              <dd>{new Date(c.offerAcceptedAt).toLocaleString(i18n.language)}</dd>
            </>
          )}
        </dl>
        <Select
          label={t('cases.stage')}
          name="stage"
          options={CaseStage.options}
          optionLabel={(v) => t(`stages.${v}`)}
          value={c.stage as CaseStage}
          onChange={(stage) => void run(() => api('POST', `/cases/${id}`, { stage }))}
        />
        {canAssign && assignees.data && (
          <Select
            label={t('cases.responsible')}
            name="responsible"
            options={assignees.data.map((a) => a.userId)}
            optionLabel={(v) => assignees.data.find((a) => a.userId === v)?.fullName ?? v}
            value={c.responsibleUserId}
            onChange={(responsibleUserId) =>
              void run(() => api('POST', `/cases/${id}`, { responsibleUserId }))
            }
          />
        )}
      </section>

      {c.amlApplicability === 'NOT_APPLICABLE_RENT_THRESHOLD' && (
        <form onSubmit={activate} className="card static stack">
          <p className="muted">{t('cases.rentHint')}</p>
          <Field
            label={t('cases.activateReason')}
            name="reason"
            value={reason}
            onChange={setReason}
          />
          <button type="submit" disabled={reason.trim().length < 10}>
            {t('cases.activateAml')}
          </button>
          <small className="muted">{t('cases.activateConfirm')}</small>
        </form>
      )}

      <h2>{t('cases.parties')}</h2>
      {c.parties.length === 0 && <p className="muted">{t('parties.none')}</p>}
      <ul className="list">
        {c.parties.map((cp) => (
          <li key={cp.id} className="card static">
            <strong>
              {t(`partyRoles.${cp.role}`)}: {cp.party.displayName}
            </strong>
            <span className="muted">
              {t(`parties.${cp.party.partyType}`)}
              {cp.party.personalCodeMasked && ` · ${cp.party.personalCodeMasked}`}
              {cp.party.companyCode && ` · ${cp.party.companyCode}`}
            </span>
            <span>
              {cp.isOurClient && t('parties.isOurClient')}
              {cp.representedByOtherBroker && ` · ${t('parties.representedByOtherBroker')}`}
            </span>
            <span>
              {t('parties.cddScope')}: {t(`parties.cddScopes.${cp.cddScope}`)}
              {cp.reliance && ` (${cp.reliance.entityName})`}
            </span>
            {cp.kyc.purpose && (
              <span className="muted">
                {t('parties.kycPurpose')}: {cp.kyc.purpose}
              </span>
            )}
            {cp.kyc.sourceOfFunds && (
              <span className="muted">
                {t('parties.kycSourceOfFunds')}: {cp.kyc.sourceOfFunds}
              </span>
            )}
            <Select
              label={t('parties.cddStatus')}
              name={`cddStatus-${cp.id}`}
              options={CddStatus.options}
              optionLabel={(v) => t(`parties.cddStatuses.${v}`)}
              value={cp.cddStatus}
              onChange={(cddStatus) =>
                void run(() => api('POST', `/cases/${id}/parties/${cp.id}`, { cddStatus }))
              }
            />
            <div className="actions">
              <button
                type="button"
                className="secondary"
                onClick={() => void run(() => api('POST', `/cases/${id}/parties/${cp.id}/remove`))}
              >
                {t('parties.remove')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      <h2>{t('parties.add')}</h2>
      <AddPartyForm caseId={id} onAdded={() => void refresh()} />
    </Page>
  );
}
