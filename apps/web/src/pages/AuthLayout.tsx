import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../icons';
import { useHealth } from '../session';
import { ThemeToggle } from '../theme';

const POINTS: [IconName, string][] = [
  ['file', 'auth.point1'],
  ['search', 'auth.point2'],
  ['shield', 'auth.point3'],
];

/**
 * Screens before the app shell (sign-in, second factor, activation): the product on the left on
 * wide screens, a single focused card on the right.
 */
export function AuthLayout(props: {
  title: string;
  subtitle?: ReactNode;
  /** Where the user is in a short flow, e.g. sign-in step 2 of 2. */
  step?: { current: number; total: number };
  /** Wider card for activation (QR code beside the instructions). */
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  const health = useHealth();
  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="auth-brand-inner">
          <p className="auth-logo">{t('app.name')}</p>
          <p className="auth-tagline">{t('auth.headline')}</p>
          <ul className="auth-points">
            {POINTS.map(([icon, key]) => (
              <li key={key}>
                <span className="auth-point-icon">
                  <Icon name={icon} />
                </span>
                {t(key)}
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-top">
          <p className="auth-logo small">{t('app.name')}</p>
          <ThemeToggle />
        </div>
        <div className={`auth-card ${props.wide ? 'wide' : ''}`}>
          {props.step && (
            <p className="auth-step">
              {t('auth.step', { current: props.step.current, total: props.step.total })}
            </p>
          )}
          <h1>{props.title}</h1>
          {props.subtitle && <p className="auth-sub">{props.subtitle}</p>}
          {props.children}
        </div>
        {props.footer && <div className="auth-footer">{props.footer}</div>}
        <p className="auth-secure">
          <Icon name="lock" size={14} /> {t('auth.secured')}
        </p>
        {health.data?.simulatedProviders && (
          <p className="auth-demo">
            <span className="badge badge-demo">DEMO</span> {t('auth.demo')}
          </p>
        )}
      </main>
    </div>
  );
}

/** Password with a show/hide switch; the switch never submits the form. */
export function PasswordField(props: {
  label: string;
  name: string;
  autoComplete: 'current-password' | 'new-password';
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  describedBy?: string;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  return (
    <label className="field">
      <span>{props.label}</span>
      <span className="input-action">
        <input
          name={props.name}
          type={shown ? 'text' : 'password'}
          autoComplete={props.autoComplete}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          autoFocus={props.autoFocus}
          aria-describedby={props.describedBy}
          spellCheck={false}
          autoCapitalize="none"
          required
        />
        <button
          type="button"
          className="ghost small"
          onClick={() => setShown(!shown)}
          aria-label={shown ? t('auth.hidePassword') : t('auth.showPassword')}
          aria-pressed={shown}
          title={shown ? t('auth.hidePassword') : t('auth.showPassword')}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} />
        </button>
      </span>
    </label>
  );
}

/** The 6-digit app code: one large field; spaces and other characters in a pasted code are dropped. */
export function CodeField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        className="code-input"
        name="code"
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="\d{6}"
        maxLength={6}
        placeholder="000000"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        autoFocus={props.autoFocus}
        required
      />
    </label>
  );
}
