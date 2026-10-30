import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ThemeToggle } from './theme';

export function Page({
  title,
  children,
  wide = false,
  medium = false,
  back,
  actions,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
  /** Width for forms that need two columns. */
  medium?: boolean;
  /** Parent page shown as a breadcrumb above the title. */
  back?: { to: string; label: string };
  /** Page-level actions next to the title (the screen's primary action goes here). */
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <main className={wide ? 'page wide' : medium ? 'page medium' : 'page'}>
      {/* Pages without the app shell (sign-in, activation) carry the brand themselves. */}
      <div className="brand-row">
        <p className="brand">{t('app.name')}</p>
        <ThemeToggle />
      </div>
      {back && (
        <Link to={back.to} className="breadcrumb">
          ← {back.label}
        </Link>
      )}
      <div className="page-head">
        <h1>{title}</h1>
        {actions}
      </div>
      {children}
    </main>
  );
}

export function Field(props: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: 'numeric' | 'email' | 'text' | 'decimal';
  required?: boolean;
  hint?: string;
  placeholder?: string;
  pattern?: string;
  /** Unit shown inside the field, e.g. EUR. */
  suffix?: string;
}) {
  const input = (
    <input
      name={props.name}
      type={props.type ?? 'text'}
      autoComplete={props.autoComplete}
      inputMode={props.inputMode}
      placeholder={props.placeholder}
      pattern={props.pattern}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      required={props.required ?? true}
    />
  );
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.suffix ? (
        <span className="input-affix">
          {input}
          <span aria-hidden="true">{props.suffix}</span>
        </span>
      ) : (
        input
      )}
      {props.hint && <small className="muted">{props.hint}</small>}
    </label>
  );
}

/**
 * Date as YYYY-MM-DD, the format used everywhere else in the app. A text field rather than the
 * browser date picker, whose format follows the browser's language instead of ours.
 */
export function DateField(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Field
      {...props}
      required={props.required ?? false}
      inputMode="numeric"
      placeholder={t('common.datePlaceholder')}
      pattern="\d{4}-\d{2}-\d{2}"
      hint={t('common.dateHint')}
    />
  );
}

export function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}

export function Select<T extends string>(props: {
  label: string;
  name: string;
  options: readonly T[];
  optionLabel: (v: T) => string;
  value: T | '';
  onChange: (value: T) => void;
  /** An empty first option; the field stays optional unless `required` is set. */
  emptyLabel?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select
        name={props.name}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value as T)}
        required={props.required ?? props.emptyLabel === undefined}
      >
        {props.emptyLabel !== undefined && <option value="">{props.emptyLabel}</option>}
        {props.options.map((o) => (
          <option key={o} value={o}>
            {props.optionLabel(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Check(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  );
}

/** A status pill; `kind` selects the colour (compliance status or `risk-LEVEL`). */
export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`badge badge-${kind.toLowerCase()}`}>{children}</span>;
}

/** Collapsed help text, e.g. which test names or company codes the demo providers react to. */
export function Hint({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="hint">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
