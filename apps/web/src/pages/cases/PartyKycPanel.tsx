import { DocumentType } from '@skydra/shared';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { Check, Field, Select } from '../../ui';
import type { CaseParty, IdentityVerification } from './types';

type Run = (action: () => Promise<unknown>) => Promise<void>;

/** Identity verification and KYC answers of one party in a case. */
export function PartyKycPanel(props: {
  caseId: string;
  caseParty: CaseParty;
  verifications: IdentityVerification[];
  simulated: boolean;
  run: Run;
}) {
  const { t, i18n } = useTranslation();
  const { caseId, caseParty: cp, verifications, simulated, run } = props;
  const base = `/cases/${caseId}/identity-verifications`;
  const pending = verifications.find((v) => v.status === 'PENDING' && v.method === 'REMOTE');
  const verified = verifications.some((v) => v.status === 'VERIFIED');

  const [doc, setDoc] = useState({
    type: '' as DocumentType | '',
    number: '',
    country: 'LT',
    expires: '',
  });
  const [kyc, setKyc] = useState({
    purpose: cp.kyc.purpose ?? '',
    sourceOfFunds: cp.kyc.sourceOfFunds ?? '',
    ownBehalf: cp.kyc.actsOnOwnBehalf ?? true,
    pep: cp.kyc.pepSelfDeclared ?? false,
  });

  async function inPerson(e: FormEvent) {
    e.preventDefault();
    await run(() =>
      api('POST', `${base}/in-person`, {
        casePartyId: cp.id,
        documentType: doc.type,
        documentNumber: doc.number,
        documentCountry: doc.country,
        documentExpiresOn: doc.expires || null,
      }),
    );
    setDoc({ type: '', number: '', country: 'LT', expires: '' });
  }

  const kycBody = () => ({
    version: 1,
    purpose: kyc.purpose.trim() || null,
    sourceOfFunds: kyc.sourceOfFunds.trim() || null,
    actsOnOwnBehalf: kyc.ownBehalf,
    pepSelfDeclared: kyc.pep,
  });
  const saveKyc = (complete: boolean) =>
    run(() =>
      api('POST', `/cases/${caseId}/parties/${cp.id}`, {
        kyc: kycBody(),
        ...(complete ? { cddStatus: 'COMPLETED' } : {}),
      }),
    );

  return (
    <div className="stack">
      {cp.party.partyType === 'NATURAL' && cp.cddScope === 'FULL' && (
        <div className="match">
          <strong>{t('identity.title')}</strong>
          {verifications.length === 0 && <span className="muted">{t('identity.none')}</span>}
          {verifications.map((v) => (
            <span key={v.id}>
              {t('identity.entry', {
                status: t(`identity.statuses.${v.status}`),
                method: t(`identity.methods.${v.method}`),
                date: new Date(v.requestedAt).toLocaleString(i18n.language),
              })}
              {v.documentType && ` · ${t(`identity.documentTypes.${v.documentType}`)}`}
              {v.documentNumberMasked && ` ${v.documentNumberMasked}`}
            </span>
          ))}
          {pending ? (
            <>
              <span className="muted">{t('identity.remotePending')}</span>
              {simulated && (
                <div className="actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void run(() =>
                        api('POST', `${base}/${pending.id}/simulate`, { outcome: 'VERIFIED' }),
                      )
                    }
                  >
                    {t('identity.simulateVerified')}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void run(() =>
                        api('POST', `${base}/${pending.id}/simulate`, { outcome: 'REJECTED' }),
                      )
                    }
                  >
                    {t('identity.simulateRejected')}
                  </button>
                </div>
              )}
            </>
          ) : (
            !verified && (
              <>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void run(() => api('POST', `${base}/remote`, { casePartyId: cp.id }))
                  }
                >
                  {t('identity.remoteStart')}
                </button>
                <form onSubmit={inPerson} className="stack">
                  <strong>{t('identity.inPerson')}</strong>
                  <Select
                    label={t('identity.documentType')}
                    name={`documentType-${cp.id}`}
                    options={DocumentType.options}
                    optionLabel={(v) => t(`identity.documentTypes.${v}`)}
                    value={doc.type}
                    onChange={(type) => setDoc({ ...doc, type })}
                    emptyLabel=""
                  />
                  <Field
                    label={t('identity.documentNumber')}
                    name={`documentNumber-${cp.id}`}
                    autoComplete="off"
                    value={doc.number}
                    onChange={(number) => setDoc({ ...doc, number })}
                    hint={t('identity.documentNumberHint')}
                  />
                  <Field
                    label={t('identity.documentCountry')}
                    name={`documentCountry-${cp.id}`}
                    value={doc.country}
                    onChange={(country) => setDoc({ ...doc, country })}
                  />
                  <Field
                    label={t('identity.documentExpiresOn')}
                    name={`documentExpiresOn-${cp.id}`}
                    type="date"
                    value={doc.expires}
                    onChange={(expires) => setDoc({ ...doc, expires })}
                    required={false}
                  />
                  <button type="submit" disabled={!doc.type}>
                    {t('identity.submit')}
                  </button>
                </form>
              </>
            )
          )}
        </div>
      )}

      {/* Answers of a completed CDD stay available but out of the way. */}
      <details className="match disclosure" open={cp.cddStatus !== 'COMPLETED'}>
        <summary>{t('kyc.edit')}</summary>
        <Field
          label={t('parties.kycPurpose')}
          name={`purpose-${cp.id}`}
          value={kyc.purpose}
          onChange={(purpose) => setKyc({ ...kyc, purpose })}
          required={false}
        />
        <Field
          label={t('parties.kycSourceOfFunds')}
          name={`sourceOfFunds-${cp.id}`}
          value={kyc.sourceOfFunds}
          onChange={(sourceOfFunds) => setKyc({ ...kyc, sourceOfFunds })}
          required={false}
        />
        <Check
          label={t('parties.kycOwnBehalf')}
          checked={kyc.ownBehalf}
          onChange={(ownBehalf) => setKyc({ ...kyc, ownBehalf })}
        />
        <Check
          label={t('parties.kycPep')}
          checked={kyc.pep}
          onChange={(pep) => setKyc({ ...kyc, pep })}
        />
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void saveKyc(false)}>
            {t('kyc.save')}
          </button>
          {cp.cddStatus !== 'COMPLETED' && (
            <button type="button" onClick={() => void saveKyc(true)}>
              {t('kyc.complete')}
            </button>
          )}
        </div>
      </details>
    </div>
  );
}
