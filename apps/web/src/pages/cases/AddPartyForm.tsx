import { PartyRole } from '@skydra/shared';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useErrorMessage } from '../../session';
import { Check, ErrorText, Field, Select } from '../../ui';
import type { Party } from './types';

const blank = {
  firstName: '',
  lastName: '',
  birthDate: '',
  personalCode: '',
  citizenship: 'LT',
  residenceCountry: 'LT',
  companyName: '',
  companyCode: '',
  registrationCountry: 'LT',
};

const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

/** Adds an existing party of the organization or a new one, with its role and KYC answers. */
export function AddPartyForm({ caseId, onAdded }: { caseId: string; onAdded: () => void }) {
  const { t } = useTranslation();
  const errorMessage = useErrorMessage();
  const [query, setQuery] = useState('');
  const [existing, setExisting] = useState<Party | null>(null);
  const [partyType, setPartyType] = useState<'NATURAL' | 'LEGAL'>('NATURAL');
  const [p, setP] = useState(blank);
  const [role, setRole] = useState<PartyRole | ''>('');
  const [isOurClient, setIsOurClient] = useState(true);
  const [otherBroker, setOtherBroker] = useState(false);
  const [reliance, setReliance] = useState({ use: false, entityName: '', entityCode: '' });
  const [kyc, setKyc] = useState({ purpose: '', sourceOfFunds: '', ownBehalf: true, pep: false });
  const [error, setError] = useState<string | null>(null);

  const found = useQuery({
    queryKey: ['parties', query],
    queryFn: () => api<Party[]>('GET', `/parties?query=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 2 && !existing,
  });

  function newParty() {
    return partyType === 'NATURAL'
      ? {
          partyType,
          firstName: p.firstName,
          lastName: p.lastName,
          birthDate: orNull(p.birthDate),
          personalCode: orNull(p.personalCode),
          citizenships: p.citizenship.trim() ? [p.citizenship] : [],
          residenceCountry: orNull(p.residenceCountry),
        }
      : {
          partyType,
          companyName: p.companyName,
          companyCode: orNull(p.companyCode),
          registrationCountry: p.registrationCountry,
        };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('POST', `/cases/${caseId}/parties`, {
        ...(existing ? { partyId: existing.id } : { party: newParty() }),
        role,
        isOurClient,
        representedByOtherBroker: otherBroker,
        cddScope: reliance.use ? 'RELIANCE' : 'FULL',
        reliance: reliance.use
          ? { entityName: reliance.entityName, entityCode: orNull(reliance.entityCode) }
          : null,
        kyc: {
          version: 1,
          purpose: orNull(kyc.purpose),
          sourceOfFunds: orNull(kyc.sourceOfFunds),
          actsOnOwnBehalf: kyc.ownBehalf,
          pepSelfDeclared: kyc.pep,
        },
      });
      setExisting(null);
      setQuery('');
      setP(blank);
      setRole('');
      onAdded();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const set = (key: keyof typeof blank) => (v: string) => setP({ ...p, [key]: v });

  return (
    <form onSubmit={submit} className="stack">
      {existing ? (
        <p>
          {t('parties.selected', { name: existing.displayName })}{' '}
          <button type="button" className="secondary" onClick={() => setExisting(null)}>
            {t('parties.newParty')}
          </button>
        </p>
      ) : (
        <>
          <Field
            label={t('parties.existing')}
            name="partySearch"
            value={query}
            onChange={setQuery}
            required={false}
            hint={t('parties.searchPlaceholder')}
          />
          {found.data?.map((party) => (
            <div key={party.id} className="actions">
              <span>
                {party.displayName}{' '}
                <span className="muted">{party.personalCodeMasked ?? party.companyCode ?? ''}</span>
              </span>
              <button type="button" className="secondary" onClick={() => setExisting(party)}>
                {t('parties.useExisting')}
              </button>
            </div>
          ))}
          <h3>{t('parties.newParty')}</h3>
          <Select
            label={t('parties.partyType')}
            name="partyType"
            options={['NATURAL', 'LEGAL'] as const}
            optionLabel={(v) => t(`parties.${v}`)}
            value={partyType}
            onChange={setPartyType}
          />
          {partyType === 'NATURAL' ? (
            <>
              <Field
                label={t('parties.firstName')}
                name="firstName"
                value={p.firstName}
                onChange={set('firstName')}
              />
              <Field
                label={t('parties.lastName')}
                name="lastName"
                value={p.lastName}
                onChange={set('lastName')}
              />
              <Field
                label={t('parties.personalCode')}
                name="personalCode"
                autoComplete="off"
                value={p.personalCode}
                onChange={set('personalCode')}
                required={false}
                hint={t('parties.personalCodeHint')}
              />
              <Field
                label={t('parties.birthDate')}
                name="birthDate"
                type="date"
                value={p.birthDate}
                onChange={set('birthDate')}
                required={false}
              />
              <Field
                label={t('parties.citizenship')}
                name="citizenship"
                value={p.citizenship}
                onChange={set('citizenship')}
                required={false}
              />
              <Field
                label={t('parties.residenceCountry')}
                name="residenceCountry"
                value={p.residenceCountry}
                onChange={set('residenceCountry')}
                required={false}
              />
            </>
          ) : (
            <>
              <Field
                label={t('parties.companyName')}
                name="companyName"
                value={p.companyName}
                onChange={set('companyName')}
              />
              <Field
                label={t('parties.companyCode')}
                name="companyCode"
                value={p.companyCode}
                onChange={set('companyCode')}
                required={false}
              />
              <Field
                label={t('parties.registrationCountry')}
                name="registrationCountry"
                value={p.registrationCountry}
                onChange={set('registrationCountry')}
              />
            </>
          )}
        </>
      )}
      <Select
        label={t('parties.role')}
        name="role"
        options={PartyRole.options}
        optionLabel={(v) => t(`partyRoles.${v}`)}
        value={role}
        onChange={setRole}
        emptyLabel=""
      />
      <Check label={t('parties.isOurClient')} checked={isOurClient} onChange={setIsOurClient} />
      <Check
        label={t('parties.representedByOtherBroker')}
        checked={otherBroker}
        onChange={setOtherBroker}
      />
      <Check
        label={t('parties.cddScopes.RELIANCE')}
        checked={reliance.use}
        onChange={(use) => setReliance({ ...reliance, use })}
      />
      {reliance.use && (
        <>
          <Field
            label={t('parties.relianceEntity')}
            name="relianceEntity"
            value={reliance.entityName}
            onChange={(entityName) => setReliance({ ...reliance, entityName })}
          />
          <Field
            label={t('parties.relianceCode')}
            name="relianceCode"
            value={reliance.entityCode}
            onChange={(entityCode) => setReliance({ ...reliance, entityCode })}
            required={false}
          />
        </>
      )}
      <Field
        label={t('parties.kycPurpose')}
        name="purpose"
        value={kyc.purpose}
        onChange={(purpose) => setKyc({ ...kyc, purpose })}
        required={false}
      />
      <Field
        label={t('parties.kycSourceOfFunds')}
        name="sourceOfFunds"
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
      <ErrorText message={error} />
      <button type="submit" disabled={!role}>
        {t('parties.submit')}
      </button>
    </form>
  );
}
