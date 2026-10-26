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
import { Link, useNavigate } from 'react-router';
import { api } from '../../api';
import { useErrorMessage } from '../../session';
import { ErrorText, Field, Page, Select } from '../../ui';

export function NewCasePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorMessage = useErrorMessage();
  const [type, setType] = useState<TransactionType>('SALE');
  const [propertyType, setPropertyType] = useState<PropertyType | ''>('');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [methodOther, setMethodOther] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rent = Number(amount.replace(',', '.'));
  const belowThreshold =
    type === 'RENT' && amount !== '' && amlApplicability('RENT', rent) !== 'APPLICABLE';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const value = amount.replace(',', '.');
      const { id } = await api<{ id: string }>('POST', '/cases', {
        transactionType: type,
        propertyType,
        propertyAddress: address,
        ...(type === 'SALE' ? { transactionValue: value } : { monthlyRent: value }),
        paymentMethod: method || null,
        paymentMethodOther: method === 'OTHER' ? methodOther : null,
      });
      await queryClient.invalidateQueries({ queryKey: ['cases'] });
      navigate(`/cases/${id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Page title={t('cases.create')}>
      <Link to="/cases">{t('common.back')}</Link>
      <form onSubmit={submit} className="stack">
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
        />
        <Field
          label={t('cases.propertyAddress')}
          name="propertyAddress"
          value={address}
          onChange={setAddress}
        />
        <Field
          label={type === 'SALE' ? t('cases.transactionValue') : t('cases.monthlyRent')}
          name="amount"
          inputMode="decimal"
          value={amount}
          onChange={setAmount}
        />
        {belowThreshold && (
          <p className="muted" role="status">
            {t('cases.rentHint', { threshold: RENT_AML_THRESHOLD_EUR })}
          </p>
        )}
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
          <Field
            label={t('cases.paymentMethodOther')}
            name="paymentMethodOther"
            value={methodOther}
            onChange={setMethodOther}
          />
        )}
        <ErrorText message={error} />
        <button type="submit" disabled={!propertyType}>
          {t('cases.createSubmit')}
        </button>
      </form>
    </Page>
  );
}
