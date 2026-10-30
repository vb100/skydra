import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, apiDownload } from '../../api';
import { useToast } from '../../feedback';
import { formatDateTime } from '../../format';
import type { Run } from './types';

type CaseExport = { id: string; sha256: string; exportedByName: string; exportedAt: string };

/** PDF export of a completed case and the register of earlier exports with their SHA-256. */
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

  async function download() {
    let hash: string | null = null;
    const ok = await run(async () => {
      hash = await apiDownload(`/cases/${caseId}/export.pdf`, `${reference}.pdf`);
    });
    if (ok) toast(t('toast.exported', { hash: `${(hash ?? '').slice(0, 16)}…` }));
  }

  return (
    <section className="card static stack">
      <h2>{t('exports.title')}</h2>
      {completed ? (
        <button type="button" className="primary" onClick={() => void download()}>
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
