import type { ScreeningStatus } from '@skydra/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { api } from '../api';
import { formatDate, formatDateTime } from '../format';
import { Badge, Page } from '../ui';
import { formatSize } from './cases/DocumentsPanel';
import { ScreeningBadge } from './cases/PartyCard';
import type { Party } from './cases/types';
import { caseLink } from './cases/useCases';

type ClientDetail = {
  party: Party;
  screening: ScreeningStatus;
  cases: {
    casePartyId: string;
    caseId: string;
    reference: string;
    role: string;
    isOurClient: boolean;
    transactionType: string;
    propertyAddress: string;
    stage: string;
    complianceStatus: string;
    responsibleName: string;
    addedAt: string;
    removedAt: string | null;
    screening: ScreeningStatus;
  }[];
  documents: {
    id: string;
    caseId: string;
    reference: string;
    category: string;
    fileName: string;
    sizeBytes: number;
    uploadedByName: string;
    uploadedAt: string;
  }[];
};

/** One client: their details, every case they are or were part of, their documents. */
export function ClientPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const client = useQuery({
    queryKey: ['clients', id],
    queryFn: () => api<ClientDetail>('GET', `/clients/${id}`),
  });
  const d = client.data;
  const p = d?.party;
  const facts: [string, string | null | undefined][] = p
    ? p.partyType === 'NATURAL'
      ? [
          [t('clients.personalCode'), p.personalCodeMasked],
          [t('clients.birthDate'), p.birthDate],
          [t('clients.citizenships'), p.citizenships.join(', ')],
          [t('clients.residence'), p.residenceCountry],
        ]
      : [
          [t('clients.companyCode'), p.companyCode],
          [t('clients.legalForm'), p.legalForm],
          [t('clients.registration'), p.registrationCountry],
          [t('clients.address'), p.registeredAddress],
        ]
    : [];

  return (
    <Page
      title={p?.displayName ?? t('clients.title')}
      actions={
        <Link to="/clients" className="button-link">
          {t('clients.back')}
        </Link>
      }
    >
      {d && p && (
        <div className="stack">
          <section className="card static stack">
            <span className="screening-head">
              <strong>{t(`parties.${p.partyType}`)}</strong>
              <ScreeningBadge status={d.screening} />
            </span>
            <small className="muted">{t('clients.screeningHint')}</small>
            <dl className="usage-grid">
              {facts
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd className="fact">{v}</dd>
                  </div>
                ))}
            </dl>
          </section>

          <section className="card static stack">
            <h2 className="card-title">{t('clients.casesTitle')}</h2>
            <ul className="list">
              {d.cases.map((c) => (
                <li key={c.casePartyId} className="card static document-row">
                  <span className="document-main">
                    <Link to={caseLink(c.caseId)}>
                      <strong>
                        {c.reference} · {t(`partyRoles.${c.role}`)}
                      </strong>
                    </Link>
                    <span>{c.propertyAddress}</span>
                    <span className="muted">
                      {t(`transactionTypes.${c.transactionType}`)} · {c.responsibleName}
                      {c.removedAt &&
                        ` · ${t('clients.removed', { date: formatDate(c.removedAt) })}`}
                    </span>
                  </span>
                  <span className="badges">
                    <Badge kind={c.complianceStatus}>
                      {t(`complianceStatuses.${c.complianceStatus}`)}
                    </Badge>
                    {!c.removedAt && <ScreeningBadge status={c.screening} />}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card static stack">
            <h2 className="card-title">{t('clients.documentsTitle')}</h2>
            {d.documents.length === 0 && <span className="muted">{t('clients.noDocuments')}</span>}
            <ul className="list">
              {d.documents.map((doc) => (
                <li key={doc.id} className="card static document-row">
                  <span className="document-main">
                    <strong>{doc.fileName}</strong>
                    <span className="muted">
                      {t(`documents.categories.${doc.category}`)} · {doc.reference}
                    </span>
                    <span className="muted">
                      {formatSize(doc.sizeBytes)} · {doc.uploadedByName},{' '}
                      {formatDateTime(doc.uploadedAt)}
                    </span>
                  </span>
                  <a
                    className="button-link"
                    href={`/api/cases/${doc.caseId}/documents/${doc.id}/file`}
                    download={doc.fileName}
                  >
                    {t('documents.download')}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Page>
  );
}
