import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, apiDownload } from '../../api';

type Run = (action: () => Promise<unknown>) => Promise<void>;
type CaseExport = { id: string; sha256: string; exportedByName: string; exportedAt: string };

/** PDF export of a completed case and the register of earlier exports with their SHA-256. */
export function ExportPanel(props: {
  caseId: string;
  reference: string;
  completed: boolean;
  run: Run;
}) {
  const { t, i18n } = useTranslation();
  const { caseId, reference, completed, run } = props;
  const exports = useQuery({
    queryKey: ['exports', caseId],
    queryFn: () => api<CaseExport[]>('GET', `/cases/${caseId}/exports`),
  });

  return (
    <section className="card static stack">
      <h2>{t('exports.title')}</h2>
      {completed ? (
        <button
          type="button"
          onClick={() =>
            void run(() => apiDownload(`/cases/${caseId}/export.pdf`, `${reference}.pdf`))
          }
        >
          {t('exports.download')}
        </button>
      ) : (
        <p className="muted">{t('exports.onlyCompleted')}</p>
      )}
      <small className="muted">{t('exports.hint')}</small>
      {exports.data?.length === 0 && <span className="muted">{t('exports.none')}</span>}
      <ul className="checklist">
        {exports.data?.map((x) => (
          <li key={x.id}>
            {t('exports.entry', {
              date: new Date(x.exportedAt).toLocaleString(i18n.language),
              by: x.exportedByName,
              hash: x.sha256.slice(0, 16) + '…',
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
