import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { useErrorMessage } from '../session';
import { ErrorText, Field, Page } from '../ui';

type LinkInfo = { purpose: 'INVITE' | 'PASSWORD_RESET'; email: string; fullName: string };

/** Token comes from the URL fragment, which the browser never sends to any server. */
function tokenFromHash(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
}

export function ActivatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const errorMessage = useErrorMessage();
  const [token] = useState(tokenFromHash);
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Remove the token from the address bar and history once read.
    window.history.replaceState(null, '', window.location.pathname);
    (async () => {
      try {
        setInfo(await api<LinkInfo>('POST', '/auth/links/inspect', { token }));
        const started = await api<{ otpauthUri: string; secret: string }>(
          'POST',
          '/auth/links/start',
          { token },
        );
        setSecret(started.secret);
        setQr(await QRCode.toDataURL(started.otpauthUri, { margin: 1, width: 220 }));
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== repeat) {
      setError(t('errors.password_mismatch'));
      return;
    }
    try {
      const done = await api<{ recoveryCodes: string[] }>('POST', '/auth/links/complete', {
        token,
        password,
        totpCode: code,
      });
      setRecoveryCodes(done.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (recoveryCodes) {
    return (
      <Page title={t('activate.recoveryTitle')}>
        <p>{t('activate.recoveryHint')}</p>
        <ul className="codes">
          {recoveryCodes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <button type="button" onClick={() => navigate('/login')}>
          {t('activate.recoveryConfirm')}
        </button>
      </Page>
    );
  }

  return (
    <Page
      title={
        info?.purpose === 'PASSWORD_RESET' ? t('activate.titleReset') : t('activate.titleInvite')
      }
    >
      {info && <p>{t('activate.forUser', { email: info.email })}</p>}
      <ErrorText message={error} />
      {qr && (
        <form onSubmit={submit} className="stack">
          <p>{t('activate.step1')}</p>
          <img src={qr} alt="QR" width={220} height={220} />
          <p className="muted">
            {t('activate.manualKey')} <code>{secret}</code>
          </p>
          <p>{t('activate.step2')}</p>
          <Field
            label={t('activate.password')}
            name="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
          />
          <Field
            label={t('activate.passwordRepeat')}
            name="repeat-password"
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={setRepeat}
          />
          <p>{t('activate.step3')}</p>
          <Field
            label={t('activate.code')}
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            value={code}
            onChange={setCode}
          />
          <button type="submit">{t('activate.submit')}</button>
        </form>
      )}
    </Page>
  );
}
