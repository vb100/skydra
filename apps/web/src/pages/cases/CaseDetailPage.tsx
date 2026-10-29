import { CaseStage, type HealthResponse } from '@skydra/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { api } from '../../api';
import { useErrorMessage } from '../../session';
import { Badge, ErrorText, Field, Page, Select } from '../../ui';
import { AddPartyForm } from './AddPartyForm';
import { ChecklistPanel } from './ChecklistPanel';
import { DecisionsPanel } from './DecisionsPanel';
import { ExportPanel } from './ExportPanel';
import { OwnershipPanel } from './OwnershipPanel';
import { PartyKycPanel } from './PartyKycPanel';
import { RiskPanel } from './RiskPanel';
import { ScreeningPanel } from './ScreeningPanel';
import type { CaseAbilities, CaseDetail, IdentityVerification, OwnershipView } from './types';

export function CaseDetailPage({ abilities }: { abilities: CaseAbilities }) {
  const { canAssign } = abilities;
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
  const verifications = useQuery({
    queryKey: ['identity', id],
    queryFn: () => api<IdentityVerification[]>('GET', `/cases/${id}/identity-verifications`),
  });
  const ownership = useQuery({
    queryKey: ['ownership', id],
    queryFn: () => api<OwnershipView[]>('GET', `/cases/${id}/ownership`),
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<HealthResponse>('GET', '/health'),
    staleTime: Infinity,
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['case', id] }),
      queryClient.invalidateQueries({ queryKey: ['cases'] }),
      ...['screenings', 'checklist', 'identity', 'decisions', 'risk', 'ownership', 'exports'].map(
        (key) => queryClient.invalidateQueries({ queryKey: [key, id] }),
      ),
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

  const amlApplies = c.amlApplicability !== 'NOT_APPLICABLE_RENT_THRESHOLD';
  const money = (v: string | null) =>
    v === null ? '' : `${Number(v).toLocaleString(i18n.language)} EUR`;

  async function activate(e: FormEvent) {
    e.preventDefault();
    await run(() => api('POST', `/cases/${id}/activate-aml`, { reason }));
    setReason('');
  }

  return (
    <Page title={`${c.reference} · ${t(`transactionTypes.${c.transactionType}`)}`} wide>
      <Link to="/cases">{t('common.back')}</Link>
      <ErrorText message={error} />
      <div className="badges">
        <Badge kind={c.complianceStatus}>{t(`complianceStatuses.${c.complianceStatus}`)}</Badge>
        {c.riskLevel && (
          <Badge kind={`risk-${c.riskLevel}`}>
            {t('risk.title')}: {t(`riskLevels.${c.riskLevel}`)}
          </Badge>
        )}
        <span className="muted">{c.propertyAddress}</span>
      </div>
      <div className="case-grid">
        <div className="case-main">
          <section className="card static">
            <dl className="facts">
              <dt>{t('cases.propertyAddress')}</dt>
              <dd>{c.propertyAddress}</dd>
              <dt>{t('cases.propertyType')}</dt>
              <dd>{t(`propertyTypes.${c.propertyType}`)}</dd>
              <dt>
                {c.transactionType === 'SALE'
                  ? t('cases.transactionValue')
                  : t('cases.monthlyRent')}
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
                {cp.beneficialOwnerOf && (
                  <span>
                    {t('ownership.ownerOf', {
                      company:
                        c.parties.find((x) => x.id === cp.beneficialOwnerOf)?.party.displayName ??
                        '',
                    })}
                  </span>
                )}
                <span>
                  {cp.isOurClient && t('parties.isOurClient')}
                  {cp.representedByOtherBroker && ` · ${t('parties.representedByOtherBroker')}`}
                </span>
                {/* A beneficial owner's CDD is covered by the legal entity's. */}
                {cp.role !== 'BENEFICIAL_OWNER' && (
                  <>
                    <span>
                      {t('parties.cddScope')}: {t(`parties.cddScopes.${cp.cddScope}`)}
                      {cp.reliance && ` (${cp.reliance.entityName})`}
                    </span>
                    <span>
                      {t('parties.cddStatus')}: {t(`parties.cddStatuses.${cp.cddStatus}`)}
                    </span>
                  </>
                )}
                {amlApplies && cp.party.partyType === 'LEGAL' && cp.cddScope === 'FULL' && (
                  <OwnershipPanel
                    caseId={id}
                    casePartyId={cp.id}
                    ownership={ownership.data?.find((o) => o.casePartyId === cp.id)}
                    simulated={!!health.data?.simulatedProviders}
                    run={run}
                  />
                )}
                {amlApplies && cp.role !== 'BENEFICIAL_OWNER' && (
                  <PartyKycPanel
                    caseId={id}
                    caseParty={cp}
                    verifications={(verifications.data ?? []).filter(
                      (v) => v.casePartyId === cp.id,
                    )}
                    simulated={!!health.data?.simulatedProviders}
                    run={run}
                  />
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void run(() => api('POST', `/cases/${id}/parties/${cp.id}/remove`))
                    }
                  >
                    {t('parties.remove')}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {amlApplies && <ScreeningPanel caseId={id} parties={c.parties} run={run} />}

          <details className="disclosure card static" open={c.parties.length === 0}>
            <summary>{t('parties.add')}</summary>
            <AddPartyForm caseId={id} onAdded={() => void refresh()} />
          </details>
        </div>
        {amlApplies && (
          <aside className="case-side">
            <ChecklistPanel caseId={id} parties={c.parties} />
            <RiskPanel caseId={id} run={run} />
            <DecisionsPanel caseId={id} abilities={abilities} run={run} />
            <ExportPanel
              caseId={id}
              reference={c.reference}
              completed={c.complianceStatus === 'COMPLETED'}
              run={run}
            />
          </aside>
        )}
      </div>
    </Page>
  );
}
