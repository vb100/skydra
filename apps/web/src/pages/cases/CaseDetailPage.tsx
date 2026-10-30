import { CaseStage, type CaseStep, caseSteps, type HealthResponse } from '@skydra/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';
import { api } from '../../api';
import { useConfirm, useToast } from '../../feedback';
import { formatDateTime, formatMoney } from '../../format';
import { useErrorMessage } from '../../session';
import { Badge, ErrorText, Field, Page, Select } from '../../ui';
import { AddPartyForm } from './AddPartyForm';
import { DecisionsPanel } from './DecisionsPanel';
import { ExportPanel } from './ExportPanel';
import { HistoryPanel } from './HistoryPanel';
import { NextStepCard } from './NextStepCard';
import { Avatar, PartyCard, StatusChips } from './PartyCard';
import { RiskPanel } from './RiskPanel';
import { ScreeningPanel } from './ScreeningPanel';
import { Stepper } from './Stepper';
import type {
  Approval,
  CaseAbilities,
  CaseDetail,
  CaseTab,
  ChecklistEntry,
  Escalation,
  IdentityVerification,
  OwnershipView,
  Run,
} from './types';

const TABS: CaseTab[] = ['overview', 'parties', 'screening', 'risk', 'decisions', 'history'];
// Where a click on a step in the step bar leads.
const TAB_OF_STEP: Record<CaseStep, CaseTab> = {
  TRANSACTION: 'overview',
  PARTIES: 'parties',
  SCREENING: 'screening',
  IDENTITY: 'parties',
  RISK: 'risk',
  COMPLETION: 'decisions',
};

/**
 * One AML case: where it stands (step bar), the next thing to do, and the work itself in tabs.
 * The tab is kept in the URL (?tab=), so a reload or a shared link opens the same view.
 */
export function CaseDetailPage({ abilities }: { abilities: CaseAbilities }) {
  const { canAssign } = abilities;
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const confirm = useConfirm();

  const detail = useQuery({
    queryKey: ['case', id],
    queryFn: () => api<CaseDetail>('GET', `/cases/${id}`),
    retry: false,
  });
  const checklist = useQuery({
    queryKey: ['checklist', id],
    queryFn: () => api<ChecklistEntry[]>('GET', `/cases/${id}/checklist`),
  });
  const decisions = useQuery({
    queryKey: ['decisions', id],
    queryFn: () =>
      api<{ approvals: Approval[]; escalations: Escalation[] }>('GET', `/cases/${id}/decisions`),
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

  const tabParam = params.get('tab') as CaseTab | null;
  const tab: CaseTab = tabParam && TABS.includes(tabParam) ? tabParam : 'overview';
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState('');

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['case', id] }),
      queryClient.invalidateQueries({ queryKey: ['cases'] }),
      ...[
        'screenings',
        'checklist',
        'identity',
        'decisions',
        'risk',
        'ownership',
        'exports',
        'history',
      ].map((key) => queryClient.invalidateQueries({ queryKey: [key, id] })),
    ]);

  const run: Run = async (action, success) => {
    try {
      await action();
      await refresh();
      if (success) toast(success);
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };

  /** Opens a tab and, for a party item, expands that party (or its company) and scrolls to it. */
  function go(next: CaseTab, casePartyId: string | null = null) {
    setParams(next === 'overview' ? {} : { tab: next }, { replace: true });
    if (next === 'parties' && !casePartyId && detail.data?.parties.length === 0) setAdding(true);
    if (casePartyId) {
      const company = detail.data?.parties.find((p) => p.id === casePartyId)?.beneficialOwnerOf;
      setExpanded((all) => new Set(all).add(company ?? casePartyId));
    }
    // After the tab has rendered, bring the target into view.
    const target = casePartyId && next === 'parties' ? `party-${casePartyId}` : 'case-tabs';
    setTimeout(
      () => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
  }

  const back = { to: '/cases', label: t('cases.title') };
  const c = detail.data;
  if (detail.error)
    return (
      <Page title={t('cases.title')} back={back}>
        <ErrorText message={errorMessage(detail.error)} />
      </Page>
    );
  if (!c)
    return (
      <Page title={t('common.loading')} back={back} wide>
        {null}
      </Page>
    );

  const amlApplies = c.amlApplicability !== 'NOT_APPLICABLE_RENT_THRESHOLD';
  const simulated = !!health.data?.simulatedProviders;
  const list = checklist.data ?? [];
  const steps = caseSteps(list);
  const topParties = c.parties.filter((p) => !p.beneficialOwnerOf);
  const ownersOf = (companyId: string) =>
    c.parties.filter((p) => p.beneficialOwnerOf === companyId);
  const client = topParties.find((p) => p.isOurClient) ?? topParties[0];
  const visibleTabs = amlApplies
    ? TABS
    : TABS.filter((x) => x === 'overview' || x === 'parties' || x === 'history');

  async function activate(e: FormEvent) {
    e.preventDefault();
    const ok = await confirm({
      title: t('confirm.activateAml'),
      body: t('confirm.irreversible'),
      confirmLabel: t('cases.activateAml'),
    });
    if (
      ok &&
      (await run(
        () => api('POST', `/cases/${id}/activate-aml`, { reason }),
        t('toast.amlActivated'),
      ))
    )
      setReason('');
  }

  async function removeParty(casePartyId: string) {
    const ok = await confirm({
      title: t('confirm.removeParty'),
      body: t('confirm.removePartyBody'),
      confirmLabel: t('confirm.remove'),
      danger: true,
    });
    if (ok)
      await run(
        () => api('POST', `/cases/${id}/parties/${casePartyId}/remove`),
        t('toast.partyRemoved'),
      );
  }

  const toggle = (partyId: string) =>
    setExpanded((all) => {
      const next = new Set(all);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });

  const facts = (
    <section className="card static stack">
      <h2 className="card-title">{t('casePage.transaction')}</h2>
      <dl className="facts-grid">
        <div>
          <dt>{t('cases.propertyType')}</dt>
          <dd>{t(`propertyTypes.${c.propertyType}`)}</dd>
        </div>
        <div>
          <dt>
            {c.transactionType === 'SALE' ? t('cases.transactionValue') : t('cases.monthlyRent')}
          </dt>
          <dd className="num">
            {formatMoney(c.transactionType === 'SALE' ? c.transactionValue : c.monthlyRent)}
          </dd>
        </div>
        <div>
          <dt>{t('cases.paymentMethod')}</dt>
          <dd>
            {c.paymentMethod
              ? `${t(`paymentMethods.${c.paymentMethod}`)}${c.paymentMethodOther ? `: ${c.paymentMethodOther}` : ''}`
              : t('cases.notSpecified')}
          </dd>
        </div>
        <div>
          <dt>{t('cases.aml')}</dt>
          <dd>{t(`amlApplicability.${c.amlApplicability}`)}</dd>
        </div>
        <div>
          <dt>{t('cases.legalRegime')}</dt>
          <dd>{t(`legalRegimes.${c.legalRegime}`)}</dd>
        </div>
        {c.offerAcceptedAt && (
          <div>
            <dt>{t('cases.offerAcceptedAt')}</dt>
            <dd>{formatDateTime(c.offerAcceptedAt)}</dd>
          </div>
        )}
        <div className="span-all">
          <dt>{t('cases.propertyAddress')}</dt>
          <dd>{c.propertyAddress}</dd>
        </div>
      </dl>
      {c.amlActivationReason && <p className="muted">{c.amlActivationReason}</p>}
      <div className="form-grid">
        <Select
          label={t('cases.stage')}
          name="stage"
          options={CaseStage.options}
          optionLabel={(v) => t(`stages.${v}`)}
          value={c.stage as CaseStage}
          onChange={(stage) =>
            void run(() => api('POST', `/cases/${id}`, { stage }), t('toast.saved'))
          }
        />
        {canAssign && assignees.data ? (
          <Select
            label={t('cases.responsible')}
            name="responsible"
            options={assignees.data.map((a) => a.userId)}
            optionLabel={(v) => assignees.data.find((a) => a.userId === v)?.fullName ?? v}
            value={c.responsibleUserId}
            onChange={(responsibleUserId) =>
              void run(() => api('POST', `/cases/${id}`, { responsibleUserId }), t('toast.saved'))
            }
          />
        ) : (
          <div className="field">
            <span>{t('cases.responsible')}</span>
            <span className="responsible">
              <Avatar name={c.responsibleName} legal={false} /> {c.responsibleName}
            </span>
          </div>
        )}
      </div>
    </section>
  );

  const activation = !amlApplies && (
    <form onSubmit={activate} className="card static stack">
      <p className="notice">{t('casePage.notApplicable')}</p>
      <Field label={t('cases.activateReason')} name="reason" value={reason} onChange={setReason} />
      <div className="actions">
        <button type="submit" disabled={reason.trim().length < 10}>
          {t('cases.activateAml')}
        </button>
      </div>
    </form>
  );

  const partiesSummary = (
    <section className="card static">
      <div className="page-head">
        <h2 className="card-title">{t('casePage.partiesSummary')}</h2>
        <button type="button" className="ghost small" onClick={() => go('parties')}>
          {t('casePage.tabs.parties')} →
        </button>
      </div>
      {topParties.length === 0 && <p className="muted">{t('casePage.noParties')}</p>}
      <ul className="party-rows">
        {topParties.map((p) => (
          <li key={p.id}>
            <button type="button" className="party-row" onClick={() => go('parties', p.id)}>
              <Avatar name={p.party.displayName} legal={p.party.partyType === 'LEGAL'} />
              <span className="party-title">
                <strong>{p.party.displayName}</strong>
                <span className="muted">{t(`partyRoles.${p.role}`)}</span>
              </span>
              <StatusChips casePartyId={p.id} checklist={list} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  const parties = (
    <div className="stack">
      <div className="page-head">
        <h2>{t('cases.parties')}</h2>
        <button
          type="button"
          className={topParties.length === 0 && !adding ? 'primary' : undefined}
          onClick={() => setAdding((a) => !a)}
        >
          {adding ? t('casePage.closeForm') : t('casePage.addParty')}
        </button>
      </div>
      {adding && (
        <section className="card static">
          <AddPartyForm
            caseId={id}
            onAdded={() => {
              toast(t('toast.partyAdded'));
              setAdding(false);
              void refresh();
            }}
          />
        </section>
      )}
      {topParties.length === 0 && !adding && <p className="muted">{t('casePage.noParties')}</p>}
      <ul className="list">
        {topParties.map((p) => (
          <PartyCard
            key={p.id}
            caseId={id}
            caseParty={p}
            owners={ownersOf(p.id)}
            checklist={list}
            ownership={ownership.data?.find((o) => o.casePartyId === p.id)}
            verifications={(verifications.data ?? []).filter((v) => v.casePartyId === p.id)}
            amlApplies={amlApplies}
            simulated={simulated}
            expanded={expanded.has(p.id)}
            onToggle={() => toggle(p.id)}
            onRemove={() => void removeParty(p.id)}
            run={run}
          />
        ))}
      </ul>
    </div>
  );

  return (
    <Page
      title={client ? `${c.reference} · ${client.party.displayName}` : c.reference}
      back={back}
      wide
    >
      <div className="case-sub">
        <Badge kind={c.complianceStatus}>{t(`complianceStatuses.${c.complianceStatus}`)}</Badge>
        {c.riskLevel && (
          <Badge kind={`risk-${c.riskLevel}`}>
            {t('risk.title')}: {t(`riskLevels.${c.riskLevel}`)}
          </Badge>
        )}
        <span className="muted">
          {t(`transactionTypes.${c.transactionType}`)} · {c.propertyAddress} ·{' '}
          {t(`stages.${c.stage}`)}
        </span>
      </div>

      {amlApplies && <Stepper steps={steps} onSelect={(s) => go(TAB_OF_STEP[s])} />}

      <div className="case-layout">
        <aside className="case-side">
          {amlApplies && checklist.data && (
            <NextStepCard
              checklist={list}
              parties={c.parties}
              approvals={decisions.data?.approvals ?? []}
              escalations={decisions.data?.escalations ?? []}
              abilities={abilities}
              responsibleUserId={c.responsibleUserId}
              onGo={go}
            />
          )}
          {amlApplies && (
            <ExportPanel
              caseId={id}
              reference={c.reference}
              completed={c.complianceStatus === 'COMPLETED'}
              run={run}
            />
          )}
        </aside>

        <div className="case-main">
          <div className="tabs" role="tablist" id="case-tabs">
            {visibleTabs.map((x) => (
              <button
                key={x}
                type="button"
                role="tab"
                aria-selected={tab === x}
                className="tab"
                onClick={() => go(x)}
              >
                {t(`casePage.tabs.${x}`)}
                {x === 'parties' && <span className="tab-count">{topParties.length}</span>}
              </button>
            ))}
          </div>
          <div role="tabpanel" className="stack">
            {tab === 'overview' && (
              <>
                {facts}
                {activation}
                {partiesSummary}
              </>
            )}
            {tab === 'parties' && parties}
            {tab === 'screening' && amlApplies && (
              <ScreeningPanel caseId={id} parties={c.parties} run={run} />
            )}
            {tab === 'risk' && amlApplies && <RiskPanel caseId={id} run={run} />}
            {tab === 'decisions' && amlApplies && (
              <DecisionsPanel caseId={id} abilities={abilities} run={run} />
            )}
            {tab === 'history' && (
              <section className="card static">
                <HistoryPanel caseId={id} />
              </section>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}
