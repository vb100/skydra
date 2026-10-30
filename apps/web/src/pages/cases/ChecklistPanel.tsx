import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import type { CaseParty, ChecklistEntry } from './types';

/** Items that stop the transaction rather than wait for the broker's next step. */
const BLOCKING = new Set(['NO_CONFIRMED_SANCTIONS', 'APPROVAL_NOT_REJECTED', 'NO_OPEN_ESCALATION']);

/**
 * What the case still needs, written as instructions ("Review the potential matches"). The
 * compliance status is derived from the same list, so the two never disagree.
 */
export function ChecklistPanel(props: {
  caseId: string;
  parties: CaseParty[];
  complianceStatus: string;
}) {
  const { t } = useTranslation();
  const checklist = useQuery({
    queryKey: ['checklist', props.caseId],
    queryFn: () => api<ChecklistEntry[]>('GET', `/cases/${props.caseId}/checklist`),
  });
  if (!checklist.data) return null;

  const missing = checklist.data.filter((e) => !e.ok);
  const blocking = missing.filter((e) => BLOCKING.has(e.item));
  const todo = missing.filter((e) => !BLOCKING.has(e.item));
  const name = (id: string | null) =>
    id ? (props.parties.find((p) => p.id === id)?.party.displayName ?? '') : null;

  return (
    <section className="card static stack">
      <h2>{t('checklist.title')}</h2>
      {blocking.length > 0 && (
        <div className="banner blocked" role="alert">
          <div>
            <strong>{t('checklist.blocked')}</strong>
            {blocking.map((e) => (
              <div key={e.item}>{t(`checklist.todo.${e.item}`)}</div>
            ))}
          </div>
        </div>
      )}
      {missing.length === 0 ? (
        <div className="banner ok">✓ {t('checklist.allDone')}</div>
      ) : (
        todo.length > 0 && (
          <ul className="todo">
            {todo.map((e) => (
              <li key={`${e.item}-${e.casePartyId ?? ''}`}>
                <span>
                  {t(`checklist.todo.${e.item}`)}
                  {e.casePartyId && <span className="who"> · {name(e.casePartyId)}</span>}
                </span>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
