import {
  amlApplicability,
  PaymentMethod,
  PropertyType,
  RENT_AML_THRESHOLD_EUR,
  TransactionType,
} from '@skydra/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../../api';
import { useToast } from '../../feedback';
import { useErrorMessage } from '../../session';
import { ErrorText, Field, Page, Select } from '../../ui';

/** Amount as typed with thousands separators ("168 000,50"); the API gets "168000.50". */
const formatAmount = (raw: string) => {
  const [int = '', dec] = raw
    .replace(/[^\d,.]/g, '')
    .replace('.', ',')
    .split(',');
  const grouped = int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  return dec === undefined ? grouped : `${grouped},${dec.slice(0, 2)}`;
};
const toNumber = (formatted: string) => formatted.replace(/\s/g, '').replace(',', '.');

export function NewCasePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const [type, setType] = useState<TransactionType>('SALE');
  const [propertyType, setPropertyType] = useState<PropertyType | ''>('');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [methodOther, setMethodOther] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const value = toNumber(amount);
  const applicability = amount === '' ? null : amlApplicability(type, Number(value));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const { id } = await api<{ id: string }>('POST', '/cases', {
        transactionType: type,
        propertyType,
        propertyAddress: address,
        ...(type === 'SALE' ? { transactionValue: value } : { monthlyRent: value }),
        paymentMethod: method || null,
        paymentMethodOther: method === 'OTHER' ? methodOther : null,
      });
      await queryClient.invalidateQueries({ queryKey: ['cases'] });
      toast(t('toast.caseCreated'));
      navigate(`/cases/${id}`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Page title={t('cases.create')} back={{ to: '/cases', label: t('cases.title') }} medium>
      <form onSubmit={submit} className="card static stack">
        <div className="form-grid">
          <Select
            label={t('cases.transactionType')}
            name="transactionType"
            options={TransactionType.options}
            optionLabel={(v) => t(`transactionTypes.${v}`)}
            value={type}
            onChange={setType}
          />
          <Select
            label={t('cases.propertyType')}
            name="propertyType"
            options={PropertyType.options}
            optionLabel={(v) => t(`propertyTypes.${v}`)}
            value={propertyType}
            onChange={setPropertyType}
            emptyLabel=""
            required
          />
          <div className="span-2">
            <Field
              label={t('cases.propertyAddress')}
              name="propertyAddress"
              value={address}
              onChange={setAddress}
            />
          </div>
          <Field
            label={type === 'SALE' ? t('cases.transactionValue') : t('cases.monthlyRent')}
            name="amount"
            inputMode="decimal"
            value={amount}
            onChange={(v) => setAmount(formatAmount(v))}
            suffix="EUR"
          />
          <Select
            label={t('cases.paymentMethod')}
            name="paymentMethod"
            options={PaymentMethod.options}
            optionLabel={(v) => t(`paymentMethods.${v}`)}
            value={method}
            onChange={setMethod}
            emptyLabel={t('cases.notSpecified')}
          />
          {method === 'OTHER' && (
            <div className="span-2">
              <Field
                label={t('cases.paymentMethodOther')}
                name="paymentMethodOther"
                value={methodOther}
                onChange={setMethodOther}
              />
            </div>
          )}
        </div>
        {applicability && (
          <p className="notice" role="status">
            {applicability === 'APPLICABLE'
              ? t('cases.amlApplies')
              : t('cases.rentHint', { threshold: RENT_AML_THRESHOLD_EUR })}
          </p>
        )}
        <ErrorText message={error} />
        <div className="actions">
          <button type="submit" className="primary" disabled={saving}>
            {t('cases.createSubmit')}
          </button>
          <span className="muted">{t('cases.newCaseHint')}</span>
        </div>
      </form>
    </Page>
  );
}
