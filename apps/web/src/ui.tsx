import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function Page({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <main className={wide ? 'page wide' : 'page'}>
      <p className="brand">{t('app.name')}</p>
      <h1>{title}</h1>
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
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        name={props.name}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        required={props.required ?? true}
      />
      {props.hint && <small className="muted">{props.hint}</small>}
    </label>
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
  emptyLabel?: string;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select
        name={props.name}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value as T)}
        required={props.emptyLabel === undefined}
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
