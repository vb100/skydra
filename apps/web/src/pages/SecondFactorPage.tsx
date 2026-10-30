import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useErrorMessage, useRefreshMe } from '../session';
import { ErrorText, Field, Page } from '../ui';

export function SecondFactorPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const refreshMe = useRefreshMe();
  const errorMessage = useErrorMessage();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(
        'POST',
        '/auth/second-factor',
        useRecovery ? { recoveryCode: value } : { code: value },
      );
      await refreshMe();
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title={t('secondFactor.title')}>
      <form onSubmit={submit} className="stack">
        {!useRecovery && <p>{t('secondFactor.codeHint')}</p>}
        <Field
          label={useRecovery ? t('secondFactor.recoveryCode') : t('secondFactor.code')}
          name="code"
          autoComplete="one-time-code"
          inputMode={useRecovery ? 'text' : 'numeric'}
          value={value}
          onChange={setValue}
        />
        <ErrorText message={error} />
        <button type="submit" className="primary block" disabled={busy}>
          {t('secondFactor.submit')}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setValue('');
          }}
        >
          {useRecovery ? t('secondFactor.useApp') : t('secondFactor.useRecovery')}
        </button>
      </form>
    </Page>
  );
}
