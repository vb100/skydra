import { PROVIDER_PRICE_EUR } from '@skydra/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useErrorMessage } from '../session';
import { ErrorText, Field, Page } from '../ui';

type Organization = { id: string; name: string; planCode: string; status: string };
type Usage = {
  month: string;
  organizationId: string;
  organization: string;
  checks: number;
  monitoringChecks: number;
  failedChecks: number;
  openSanctions: number;
  brave: number;
  gdelt: number;
};
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
      <UsageTable />
    </Page>
  );
}

const euro = new Intl.NumberFormat('lt-LT', { style: 'currency', currency: 'EUR' });

/** Screening volume and provider requests per month: what the providers will bill. */
function UsageTable() {
  const { t } = useTranslation();
  const usage = useQuery({
    queryKey: ['platform', 'usage'],
    queryFn: () => api<Usage[]>('GET', '/platform/usage?months=6'),
  });
  const rows = usage.data ?? [];
  const cost = (requests: number) => euro.format(requests * PROVIDER_PRICE_EUR.OPENSANCTIONS);
  const total = rows.reduce((n, r) => n + r.openSanctions, 0);
  return (
    <>
      <h2>{t('platform.usage.title')}</h2>
      <p className="muted">{t('platform.usage.hint')}</p>
      {usage.isSuccess && rows.length === 0 && <p>{t('platform.usage.none')}</p>}
      <ul className="list">
        {rows.map((r) => (
          <li key={`${r.month}-${r.organizationId}`} className="card static">
            <strong>
              {r.month} · {r.organization}
            </strong>
            <dl className="usage-grid">
              <div>
                <dt>{t('platform.usage.checks')}</dt>
                <dd>
                  {r.checks}
                  <span className="muted">
                    {t('platform.usage.checksDetail', {
                      monitoring: r.monitoringChecks,
                      failed: r.failedChecks,
                    })}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t('platform.usage.openSanctions')}</dt>
                <dd>
                  {r.openSanctions}
                  <span className="muted">≈ {cost(r.openSanctions)}</span>
                </dd>
              </div>
              <div>
                <dt>{t('platform.usage.brave')}</dt>
                <dd>{r.brave}</dd>
              </div>
              <div>
                <dt>{t('platform.usage.gdelt')}</dt>
                <dd>{r.gdelt}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      {rows.length > 1 && (
        <p>
          <strong>{t('platform.usage.total', { cost: cost(total), requests: total })}</strong>
        </p>
      )}
    </>
  );
}
