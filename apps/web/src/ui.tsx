import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export function Page({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <main className="page">
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
  inputMode?: 'numeric' | 'email' | 'text';
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
        required
      />
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
