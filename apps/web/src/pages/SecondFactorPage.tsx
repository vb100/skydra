import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api } from '../api';
import { Icon } from '../icons';
import { useErrorMessage, useRefreshMe } from '../session';
import { ErrorText, Field } from '../ui';
import { AuthLayout, CodeField } from './AuthLayout';

export function SecondFactorPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const refreshMe = useRefreshMe();
  const errorMessage = useErrorMessage();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify(input: string) {
    setBusy(true);
    setError(null);
    try {
      await api(
        'POST',
        '/auth/second-factor',
        useRecovery ? { recoveryCode: input.trim() } : { code: input },
      );
      await refreshMe();
      navigate('/');
    } catch (err) {
      setError(errorMessage(err));
      setValue('');
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void verify(value);
  }

  // The sixth digit sends the code: one step fewer on every sign-in.
  function onCode(code: string) {
    setValue(code);
    if (code.length === 6 && !busy) void verify(code);
  }

  return (
    <AuthLayout
      title={t('secondFactor.title')}
      subtitle={useRecovery ? t('secondFactor.recoveryHint') : t('secondFactor.codeHint')}
      step={{ current: 2, total: 2 }}
      footer={
        <Link to="/login" className="auth-back">
          <Icon name="arrowLeft" size={16} /> {t('auth.backToLogin')}
        </Link>
      }
    >
      <form onSubmit={submit} className="stack">
        {useRecovery ? (
          <Field
            label={t('secondFactor.recoveryCode')}
            name="recovery-code"
            autoComplete="off"
            value={value}
            onChange={setValue}
          />
        ) : (
          <CodeField label={t('secondFactor.code')} value={value} onChange={onCode} autoFocus />
        )}
        <ErrorText message={error} />
        <button type="submit" className="primary block large" disabled={busy}>
          {busy ? t('secondFactor.busy') : t('secondFactor.submit')}
        </button>
        <button
          type="button"
          className="link center"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setValue('');
            setError(null);
          }}
        >
          {useRecovery ? t('secondFactor.useApp') : t('secondFactor.useRecovery')}
        </button>
      </form>
    </AuthLayout>
  );
}
