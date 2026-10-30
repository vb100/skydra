import { type ChecklistResult, nextStep } from '@skydra/shared';
import { useTranslation } from 'react-i18next';
import type { Approval, CaseAbilities, CaseParty, CaseTab, Escalation } from './types';

/** Where each checklist item is done. */
export const TAB_OF_ITEM: Record<ChecklistResult['item'], CaseTab> = {
  PARTIES_ADDED: 'parties',
  OWNERSHIP_FETCHED: 'parties',
  OWNERSHIP_RESOLVED: 'parties',
  UBOS_LINKED: 'parties',
  IDENTITY_VERIFIED: 'parties',
  CDD_COMPLETED: 'parties',
  SCREENED: 'screening',
  MATCHES_REVIEWED: 'screening',
  RISK_ASSESSED: 'risk',
  EDD_APPROVED: 'decisions',
  NO_CONFIRMED_SANCTIONS: 'decisions',
  APPROVAL_NOT_REJECTED: 'decisions',
  NO_OPEN_ESCALATION: 'decisions',
};

type Next = { tone: 'todo' | 'blocked' | 'done' | 'waiting'; body: string; action?: string };

/**
 * The single next action for the person looking at the case, with a button that takes them to
 * the place where it is done. Approvals and escalations depend on who is looking: the approver
 * is asked to decide, the broker waits.
 */
export function NextStepCard(props: {
  checklist: ChecklistResult[];
  parties: CaseParty[];
  approvals: Approval[];
  escalations: Escalation[];
  abilities: CaseAbilities;
  responsibleUserId: string;
  onGo: (tab: CaseTab, casePartyId: string | null) => void;
}) {
  const { t } = useTranslation();
  const { checklist, abilities } = props;
  const next = nextStep(checklist);
  const remaining = checklist.filter((e) => !e.ok && e !== next);
  const name = (id: string | null) =>
    id ? props.parties.find((p) => p.id === id)?.party.displayName : undefined;

  let view: Next;
  if (!next) view = { tone: 'done', body: t('nextStep.doneBody') };
  else {
    const item = next.item;
    view = {
      tone: ['NO_CONFIRMED_SANCTIONS', 'APPROVAL_NOT_REJECTED', 'NO_OPEN_ESCALATION'].includes(item)
        ? 'blocked'
        : 'todo',
      body: t(`nextStep.items.${item}.body`),
      action: t(`nextStep.items.${item}.action`),
    };
    const open = props.approvals.find((a) => a.status === 'OPEN');
    if (item === 'EDD_APPROVED' && open) {
      const fourEyes =
        abilities.solo ||
        (abilities.userId !== props.responsibleUserId && abilities.userId !== open.requestedBy);
      view =
        abilities.canApprove && fourEyes
          ? {
              tone: 'todo',
              body: t('nextStep.decideApproval'),
              action: t('nextStep.decideApprovalAction'),
            }
          : { tone: 'waiting', body: t('nextStep.waitingApproval') };
    }
    if (item === 'NO_OPEN_ESCALATION') {
      const escalation = props.escalations.find((e) => e.status !== 'CLEARED');
      if (escalation?.status === 'REPORTED')
        view = { tone: 'blocked', body: t('nextStep.reported') };
      else if (abilities.isAmlOfficer)
        view = {
          tone: 'blocked',
          body: t('nextStep.resolveEscalation'),
          action: t('nextStep.resolveEscalationAction'),
        };
    }
  }

  const title =
    view.tone === 'done'
      ? t('nextStep.doneTitle')
      : view.tone === 'blocked'
        ? t('nextStep.blockedTitle')
        : t('nextStep.title');
  const who = next ? name(next.casePartyId) : undefined;

  return (
    <section className={`card static next-step next-${view.tone}`} aria-live="polite">
      <span className="next-label">{title}</span>
      {next && (
        <strong className="next-what">
          {t(`checklist.todo.${next.item}`)}
          {who && <span className="who"> · {who}</span>}
        </strong>
      )}
      <p>{view.body}</p>
      {next && view.action && (
        <div className="actions">
          <button
            type="button"
            className={view.tone === 'blocked' ? 'danger solid' : 'primary'}
            onClick={() => props.onGo(TAB_OF_ITEM[next.item], next.casePartyId)}
          >
            {view.action} →
          </button>
        </div>
      )}
      {remaining.length > 0 && (
        <details className="hint remaining">
          <summary>{t('casePage.remaining', { count: remaining.length })}</summary>
          <ul className="todo">
            {remaining.map((e) => (
              <li key={`${e.item}-${e.casePartyId ?? ''}`}>
                <span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => props.onGo(TAB_OF_ITEM[e.item], e.casePartyId)}
                  >
                    {t(`checklist.todo.${e.item}`)}
                  </button>
                  {e.casePartyId && <span className="who"> · {name(e.casePartyId)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
