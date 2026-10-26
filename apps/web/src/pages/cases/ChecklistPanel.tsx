import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import type { CaseParty, ChecklistEntry } from './types';

/** What the case still needs; the compliance status is derived from the same list. */
export function ChecklistPanel({ caseId, parties }: { caseId: string; parties: CaseParty[] }) {
  const { t } = useTranslation();
  const checklist = useQuery({
    queryKey: ['checklist', caseId],
    queryFn: () => api<ChecklistEntry[]>('GET', `/cases/${caseId}/checklist`),
  });
  if (!checklist.data) return null;
  const missing = checklist.data.filter((e) => !e.ok);
  const name = (id: string | null) =>
    id ? (parties.find((p) => p.id === id)?.party.displayName ?? '') : null;

  return (
    <section className="card static">
      <h2>{t('checklist.title')}</h2>
      {missing.length === 0 ? (
        <p>✓ {t('checklist.allDone')}</p>
      ) : (
        <ul className="checklist">
          {missing.map((e) => (
            <li key={`${e.item}-${e.casePartyId ?? ''}`}>
              {e.casePartyId && t('checklist.party', { name: name(e.casePartyId) })}
              {t(`checklist.items.${e.item}`)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
