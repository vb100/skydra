import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useErrorMessage } from '../session';
import { ErrorText, Field } from '../ui';
import { AuthLayout, PasswordField } from './AuthLayout';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const errorMessage = useErrorMessage();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/login', { email: email.trim(), password });
      navigate('/login/second-factor');
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={t('login.title')}
      subtitle={t('login.subtitle')}
      step={{ current: 1, total: 2 }}
      footer={
        <>
          <details className="auth-help">
            <summary>{t('login.forgot')}</summary>
            <p>{t('login.forgotHint')}</p>
          </details>
          <details className="auth-help">
            <summary>{t('login.noAccount')}</summary>
            <p>{t('login.noAccountHint')}</p>
          </details>
        </>
      }
    >
      <form onSubmit={submit} className="stack">
        <Field
          label={t('login.email')}
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          value={email}
          onChange={setEmail}
        />
        <PasswordField
          label={t('login.password')}
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
        />
        <ErrorText message={error} />
        <button type="submit" className="primary block large" disabled={busy}>
          {busy ? t('login.busy') : t('login.submit')}
        </button>
      </form>
    </AuthLayout>
  );
}
