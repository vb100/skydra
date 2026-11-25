import { DocumentCategory, MAX_DOCUMENT_BYTES } from '@skydra/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiUpload } from '../../api';
import { formatDateTime } from '../../format';
import { Field, Select } from '../../ui';
import type { CaseDocument, CaseParty, Run } from './types';
import { useCaseLocked } from './caseLock';

const CATEGORIES = DocumentCategory.options;

export const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

export function useDocuments(caseId: string) {
  return useQuery({
    queryKey: ['documents', caseId],
    queryFn: () => api<CaseDocument[]>('GET', `/cases/${caseId}/documents`),
  });
}

/**
 * Upload a document to the case: the file and what it is. On a phone the file picker also
 * offers the camera. Returns the stored document.
 */
export function UploadForm(props: {
  caseId: string;
  parties: CaseParty[];
  run: Run;
  category?: CaseDocument['category'];
  casePartyId?: string;
  onUploaded?: (document: CaseDocument) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<CaseDocument['category'] | ''>(props.category ?? '');
  const [casePartyId, setCasePartyId] = useState(props.casePartyId ?? '');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const tooLarge = !!file && file.size > MAX_DOCUMENT_BYTES;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file || !category || tooLarge) return;
    setBusy(true);
    let stored: CaseDocument | null = null;
    const ok = await props.run(async () => {
      stored = await apiUpload<CaseDocument>(`/cases/${props.caseId}/documents`, file, {
        category,
        fileName: file.name,
        ...(casePartyId ? { casePartyId } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
    }, t('documents.uploaded'));
    setBusy(false);
    if (!ok || !stored) return;
    await queryClient.invalidateQueries({ queryKey: ['documents', props.caseId] });
    setFile(null);
    setDescription('');
    if (input.current) input.current.value = '';
    props.onUploaded?.(stored);
  }

  return (
    <form onSubmit={submit} className="stack">
      <label className="field">
        <span>{t('documents.file')}</span>
        <input
          ref={input}
          type="file"
          name="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
      </label>
      {tooLarge && <span className="error">{t('documents.tooLarge')}</span>}
      {!props.category && (
        <Select
          label={t('documents.category')}
          name="category"
          options={CATEGORIES}
          optionLabel={(v) => t(`documents.categories.${v}`)}
          value={category}
          onChange={setCategory}
          emptyLabel=""
          required
        />
      )}
      {!props.casePartyId && props.parties.length > 0 && (
        <Select
          label={t('documents.party')}
          name="casePartyId"
          options={props.parties.map((p) => p.id)}
          optionLabel={(id) => props.parties.find((p) => p.id === id)?.party.displayName ?? id}
          value={casePartyId}
          onChange={setCasePartyId}
          emptyLabel={t('documents.noParty')}
        />
      )}
      {!props.compact && (
        <Field
          label={t('documents.description')}
          name="description"
          value={description}
          onChange={setDescription}
          required={false}
        />
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={!file || !category || tooLarge || busy}>
          {busy ? t('documents.uploading') : t('documents.upload')}
        </button>
      </div>
    </form>
  );
}

/** The documents of a case: what is on file, and adding more. Documents are never removed. */
export function DocumentsPanel(props: { caseId: string; parties: CaseParty[]; run: Run }) {
  const { t } = useTranslation();
  const locked = useCaseLocked();
  const documents = useDocuments(props.caseId);
  const party = (id: string | null) =>
    props.parties.find((p) => p.id === id)?.party.displayName ?? null;
  return (
    <section className="stack">
      <h2>{t('documents.title')}</h2>
      <p className="muted">{t('documents.hint')}</p>
      {!locked && (
        <section className="card static">
          <h3 className="card-title">{t('documents.add')}</h3>
          <UploadForm caseId={props.caseId} parties={props.parties} run={props.run} />
        </section>
      )}
      {documents.isSuccess && documents.data.length === 0 && (
        <p className="muted">{t('documents.none')}</p>
      )}
      <ul className="list">
        {documents.data?.map((d) => (
          <li key={d.id} className="card static document-row">
            <span className="document-main">
              <strong>{d.fileName}</strong>
              <span className="muted">
                {t(`documents.categories.${d.category}`)}
                {party(d.casePartyId) && ` · ${party(d.casePartyId)}`}
              </span>
              {d.description && <span>{d.description}</span>}
              <span className="muted">
                {t('documents.meta', {
                  size: formatSize(d.sizeBytes),
                  who: d.uploadedByName,
                  date: formatDateTime(d.uploadedAt),
                })}
              </span>
            </span>
            <a
              className="button-link"
              href={`/api/cases/${props.caseId}/documents/${d.id}/file`}
              download={d.fileName}
            >
              {t('documents.download')}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
