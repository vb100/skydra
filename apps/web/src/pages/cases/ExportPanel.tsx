import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, apiDownload } from '../../api';
import { useToast } from '../../feedback';
import { formatDateTime } from '../../format';
import type { Run } from './types';

type CaseExport = {
  id: string;
  format: 'PDF' | 'ZIP';
  sha256: string;
  exportedByName: string;
  exportedAt: string;
};

/**
 * Export of a completed case (client answer Q44): the report as PDF, or the complete case as a
 * ZIP with every document; and the register of earlier exports with their SHA-256.
 */
export function ExportPanel(props: {
  caseId: string;
  reference: string;
  completed: boolean;
  run: Run;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { caseId, reference, completed, run } = props;
  const exports = useQuery({
    queryKey: ['exports', caseId],
    queryFn: () => api<CaseExport[]>('GET', `/cases/${caseId}/exports`),
  });

  async function download(format: 'pdf' | 'zip') {
    let hash: string | null = null;
    const name = format === 'pdf' ? `${reference}.pdf` : `Case_${reference}.zip`;
    const ok = await run(async () => {
      hash = await apiDownload(`/cases/${caseId}/export.${format}`, name);
    });
    if (ok) toast(t('toast.exported', { hash: `${(hash ?? '').slice(0, 16)}…` }));
  }

  // Before completion the panel is a single line; the list of exports appears once there is one.
  if (!completed && exports.data?.length === 0)
    return (
      <section className="card static export-compact">
        <h2 className="card-title">{t('exports.title')}</h2>
        <span className="muted">{t('exports.onlyCompleted')}</span>
      </section>
    );

  return (
    <section className="card static stack">
      <h2 className="card-title">{t('exports.title')}</h2>
      {completed ? (
        <div className="actions">
          <button type="button" className="primary" onClick={() => void download('pdf')}>
            {t('exports.download')}
          </button>
          <button type="button" onClick={() => void download('zip')}>
            {t('exports.downloadZip')}
          </button>
        </div>
      ) : (
        <p className="muted">{t('exports.onlyCompleted')}</p>
      )}
      <small className="muted">{t('exports.hint')}</small>
      {exports.data?.length === 0 && <span className="muted">{t('exports.none')}</span>}
      <ul className="checklist">
        {exports.data?.map((x) => (
          <li key={x.id}>
            {t('exports.entry', {
              format: x.format,
              date: formatDateTime(x.exportedAt),
              by: x.exportedByName,
              hash: x.sha256.slice(0, 16) + '…',
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
