import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '../../feedback';
import { formatDateTime } from '../../format';
import { Field } from '../../ui';
import type { CaseRevision, Run } from './types';

/**
 * A completed case is locked; changing it means reopening it with a reason (client answer Q26).
 * While reopened, the banner says since when and why, until a new final decision closes it.
 */
export function ReopenBanner(props: {
  caseId: string;
  locked: boolean;
  open: CaseRevision | null;
  run: Run;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [form, setForm] = useState(false);
  const [reason, setReason] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await confirm({
      title: t('revisions.confirm'),
      body: t('revisions.confirmBody'),
      confirmLabel: t('revisions.reopen'),
    });
    if (!ok) return;
    const done = await props.run(
      () => api('POST', `/cases/${props.caseId}/reopen`, { reason }),
      t('revisions.reopened'),
    );
    if (done) {
      setForm(false);
      setReason('');
    }
  }

  if (props.open)
    return (
      <div className="banner warn" role="status">
        <div className="stack-tight">
          <strong>
            {t('revisions.openTitle', {
              date: formatDateTime(props.open.openedAt),
              by: props.open.openedByName,
            })}
          </strong>
          <span>{props.open.reason}</span>
          <span className="muted">{t('revisions.openHint')}</span>
        </div>
      </div>
    );
  if (!props.locked) return null;
  return (
    <div className="banner locked" role="status">
      <div className="stack-tight">
        <strong>{t('revisions.lockedTitle')}</strong>
        <span className="muted">{t('revisions.lockedHint')}</span>
        {form ? (
          <form onSubmit={submit} className="stack">
            <Field
              label={t('revisions.reason')}
              name="reopenReason"
              value={reason}
              onChange={setReason}
            />
            <div className="actions">
              <button type="submit" className="primary" disabled={reason.trim().length < 10}>
                {t('revisions.reopen')}
              </button>
              <button type="button" className="ghost" onClick={() => setForm(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <div className="actions">
            <button type="button" onClick={() => setForm(true)}>
              {t('revisions.reopen')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
