import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useErrorMessage } from '../session';
import { ErrorText, Field, Page } from '../ui';

type Organization = { id: string; name: string; planCode: string; status: string };
const PLANS = ['INDIVIDUAL', 'AGENCY', 'AGENCY_PRO'] as const;

export function PlatformPage() {
  const { t } = useTranslation();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const organizations = useQuery({
    queryKey: ['platform', 'organizations'],
    queryFn: () => api<Organization[]>('GET', '/platform/organizations'),
  });
  const [form, setForm] = useState({
    name: '',
    planCode: 'AGENCY',
    adminEmail: '',
    adminFullName: '',
  });
  const [invite, setInvite] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInvite(null);
    try {
      const created = await api<{ inviteUrl: string }>('POST', '/platform/organizations', form);
      setInvite(created.inviteUrl);
      setForm({ name: '', planCode: 'AGENCY', adminEmail: '', adminFullName: '' });
      await queryClient.invalidateQueries({ queryKey: ['platform', 'organizations'] });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  return (
    <Page title={t('platform.title')}>
      <h2>{t('platform.create')}</h2>
      <form onSubmit={submit} className="stack">
        <Field label={t('platform.name')} name="name" value={form.name} onChange={set('name')} />
        <label className="field">
          <span>{t('platform.plan')}</span>
          <select value={form.planCode} onChange={(e) => set('planCode')(e.target.value)}>
            {PLANS.map((p) => (
              <option key={p} value={p}>
                {t(`plans.${p}`)}
              </option>
            ))}
          </select>
        </label>
        <Field
          label={t('platform.adminEmail')}
          name="adminEmail"
          type="email"
          inputMode="email"
          value={form.adminEmail}
          onChange={set('adminEmail')}
        />
        <Field
          label={t('platform.adminName')}
          name="adminFullName"
          value={form.adminFullName}
          onChange={set('adminFullName')}
        />
        <ErrorText message={error} />
        <button type="submit" className="primary">
          {t('platform.submit')}
        </button>
      </form>
      {invite && (
        <section className="card static">
          <p>{t('platform.inviteReady')}</p>
          <code className="wrap">{invite}</code>
          <button
            type="button"
            className="secondary"
            onClick={() => void navigator.clipboard.writeText(invite)}
          >
            {t('common.copy')}
          </button>
        </section>
      )}
      <h2>{t('platform.organizations')}</h2>
      {organizations.data?.length === 0 && <p>{t('platform.none')}</p>}
      <ul className="list">
        {organizations.data?.map((o) => (
          <li key={o.id} className="card static">
            <strong>{o.name}</strong>
            <span className="muted">
              {t(`plans.${o.planCode}`)} · {o.status}
            </span>
          </li>
        ))}
      </ul>
    </Page>
  );
}
