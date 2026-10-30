import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api, ApiError } from '../api';
import { useToast } from '../feedback';
import { Icon } from '../icons';
import { useErrorMessage } from '../session';
import { ErrorText } from '../ui';
import { AuthLayout, CodeField, PasswordField } from './AuthLayout';

type LinkInfo = { purpose: 'INVITE' | 'PASSWORD_RESET'; email: string; fullName: string };

/** Mirrors NewPassword in the API (NIST SP 800-63B: length, no composition rules). */
const MIN_PASSWORD = 12;

/** Token comes from the URL fragment, which the browser never sends to any server. */
function tokenFromHash(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
}

export function ActivatePage() {
  const { t } = useTranslation();
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const [token] = useState(tokenFromHash);
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        setQr(await QRCode.toDataURL(started.otpauthUri, { margin: 1, width: 200 }));
      } catch (err) {
        // A malformed or missing token is just another invalid link to the user.
        const badLink =
          err instanceof ApiError && ['invalid_input', 'invalid_link'].includes(err.code);
        setLinkError(badLink ? t('errors.invalid_link') : errorMessage(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const longEnough = password.trim().length >= MIN_PASSWORD;
  const matches = repeat.length > 0 && password === repeat;
  const ready = longEnough && matches && code.length === 6;
  const reset = info?.purpose === 'PASSWORD_RESET';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api<{ recoveryCodes: string[] }>('POST', '/auth/links/complete', {
        token,
        password,
        totpCode: code,
      });
      setRecoveryCodes(done.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text).then(() => toast(t('common.copied')));
  }

  if (recoveryCodes) return <RecoveryCodes codes={recoveryCodes} reset={reset} />;

  if (linkError) {
    return (
      <AuthLayout title={t('activate.invalidTitle')} subtitle={linkError}>
        <p>{t('activate.invalidHint')}</p>
        <Link to="/login" className="button-link block">
          {t('auth.backToLogin')}
        </Link>
      </AuthLayout>
    );
  }

  if (!info || !qr) {
    return (
      <AuthLayout title={t('activate.titleInvite')}>
        <p className="muted" role="status">
          {t('activate.loading')}
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={reset ? t('activate.titleReset') : t('activate.titleInvite')}
      subtitle={
        <>
          {t('activate.greeting', { name: info.fullName })} <strong>{info.email}</strong>
        </>
      }
      wide
    >
      <form onSubmit={submit} className="activate">
        <section className="activate-step">
          <h2>
            <span className="step-no">1</span> {t('activate.appTitle')}
          </h2>
          <div className="qr-row">
            <img src={qr} alt={t('activate.qrAlt')} width={160} height={160} className="qr" />
            <div className="stack-sm">
              <p>{t('activate.appHint')}</p>
              <details className="auth-help">
                <summary>{t('activate.manualKey')}</summary>
                <span className="secret">
                  <code>{secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => copy(secret)}
                    aria-label={t('common.copy')}
                    title={t('common.copy')}
                  >
                    <Icon name="copy" size={16} />
                  </button>
                </span>
              </details>
            </div>
          </div>
        </section>

        <section className="activate-step">
          <h2>
            <span className="step-no">2</span> {t('activate.passwordTitle')}
          </h2>
          <div className="stack">
            <PasswordField
              label={t('activate.password')}
              name="new-password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              describedBy="password-rules"
            />
            <PasswordField
              label={t('activate.passwordRepeat')}
              name="repeat-password"
              autoComplete="new-password"
              value={repeat}
              onChange={setRepeat}
              describedBy="password-rules"
            />
            <ul className="rules" id="password-rules" aria-live="polite">
              <Rule ok={longEnough}>{t('activate.ruleLength', { count: MIN_PASSWORD })}</Rule>
              <Rule ok={matches}>{t('activate.ruleMatch')}</Rule>
            </ul>
          </div>
        </section>

        <section className="activate-step">
          <h2>
            <span className="step-no">3</span> {t('activate.codeTitle')}
          </h2>
          <CodeField label={t('activate.code')} value={code} onChange={setCode} />
        </section>

        <ErrorText message={error} />
        <button type="submit" className="primary block large" disabled={!ready || busy}>
          {busy ? t('activate.busy') : t('activate.submit')}
        </button>
      </form>
    </AuthLayout>
  );
}

function Rule({ ok, children }: { ok: boolean; children: string }) {
  return (
    <li className={ok ? 'ok' : undefined}>
      <span className="rule-mark" aria-hidden="true">
        {ok && <Icon name="check" size={12} />}
      </span>
      {children}
    </li>
  );
}

/** Shown once: the user saves the codes before going on. */
function RecoveryCodes({ codes, reset }: { codes: string[]; reset: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');

  function download() {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'skydra-atsarginiai-kodai.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <AuthLayout
      title={t('activate.recoveryTitle')}
      subtitle={reset ? t('activate.doneReset') : t('activate.doneInvite')}
    >
      <div className="stack">
        <p>{t('activate.recoveryHint')}</p>
        <ol className="recovery-codes">
          {codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ol>
        <div className="actions">
          <button
            type="button"
            className="small"
            onClick={() =>
              void navigator.clipboard.writeText(text).then(() => toast(t('common.copied')))
            }
          >
            <Icon name="copy" size={16} /> {t('activate.recoveryCopy')}
          </button>
          <button type="button" className="small" onClick={download}>
            <Icon name="download" size={16} /> {t('activate.recoveryDownload')}
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          {t('activate.recoverySaved')}
        </label>
        <button
          type="button"
          className="primary block large"
          disabled={!saved}
          onClick={() => navigate('/login')}
        >
          {t('activate.recoveryConfirm')}
        </button>
      </div>
    </AuthLayout>
  );
}
