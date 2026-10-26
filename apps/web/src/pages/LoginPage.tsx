import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useErrorMessage } from '../session';
import { ErrorText, Field, Page } from '../ui';

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
      await api('POST', '/auth/login', { email, password });
      navigate('/login/second-factor');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title={t('login.title')}>
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
        <Field
          label={t('login.password')}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
        />
        <ErrorText message={error} />
        <button type="submit" disabled={busy}>
          {t('login.submit')}
        </button>
      </form>
    </Page>
  );
}
