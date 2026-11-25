import { MAX_LOGO_BYTES } from '@skydra/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiUpload } from '../api';
import { useToast } from '../feedback';
import { useErrorMessage } from '../session';
import { ErrorText, Field, Page } from '../ui';

type Profile = {
  id: string;
  name: string;
  companyCode: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  hasLogo: boolean;
  logoUpdatedAt: string | null;
};

const FIELDS = ['name', 'companyCode', 'address', 'phone', 'email', 'website'] as const;
type Form = Record<(typeof FIELDS)[number], string>;

/**
 * The agency's details and logo shown at the top of every case export (client answer Q43).
 * Members who see this page may read them; the organization administrator edits them.
 */
export function OrganizationPage({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: ['organization', 'profile'],
    queryFn: () => api<Profile>('GET', '/organization/profile'),
  });
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function act(work: () => Promise<Profile>, done: string) {
    setError(null);
    setBusy(true);
    try {
      const updated = await work();
      queryClient.setQueryData(['organization', 'profile'], updated);
      toast(done);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (form)
      await act(
        () => api<Profile>('POST', '/organization/profile', form),
        t('organizationProfile.saved'),
      );
  }

  async function upload(file: File) {
    if (file.size > MAX_LOGO_BYTES) {
      setError(t('organizationProfile.logoTooLarge'));
      return;
    }
    await act(
      () => apiUpload<Profile>('/organization/logo', file, {}),
      t('organizationProfile.logoUploaded'),
    );
    if (fileInput.current) fileInput.current.value = '';
  }

  const p = profile.data;
  // The saved details until the admin edits them.
  const shown: Form | null =
    form ?? (p ? (Object.fromEntries(FIELDS.map((k) => [k, p[k] ?? ''])) as Form) : null);
  const set = (key: keyof Form) => (value: string) => shown && setForm({ ...shown, [key]: value });
  return (
    <Page title={t('organizationProfile.title')}>
      <p className="muted">{t('organizationProfile.hint')}</p>
      {!canManage && <p className="notice">{t('organizationProfile.readOnly')}</p>}
      <ErrorText message={error} />

      <section className="card static stack">
        <h2 className="card-title">{t('organizationProfile.logo')}</h2>
        {p?.hasLogo ? (
          <img
            className="org-logo"
            src={`/api/organization/logo?v=${encodeURIComponent(p.logoUpdatedAt ?? '')}`}
            alt={t('organizationProfile.logo')}
          />
        ) : (
          <span className="muted">{t('organizationProfile.logoNone')}</span>
        )}
        {canManage && (
          <>
            <label className="field">
              <span>{t('organizationProfile.logoUpload')}</span>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
            </label>
            <small className="muted">{t('organizationProfile.logoHint')}</small>
            {p?.hasLogo && (
              <div className="actions">
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => api<Profile>('POST', '/organization/logo/remove'),
                      t('organizationProfile.logoRemoved'),
                    )
                  }
                >
                  {t('organizationProfile.logoRemove')}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {shown && (
        <section className="card static">
          <form onSubmit={save} className="stack">
            {FIELDS.map((key) => (
              <fieldset key={key} disabled={!canManage} className="plain">
                <Field
                  label={t(`organizationProfile.${key}`)}
                  name={key}
                  type={key === 'email' ? 'email' : key === 'website' ? 'url' : 'text'}
                  value={shown[key]}
                  onChange={set(key)}
                  required={key === 'name'}
                />
              </fieldset>
            ))}
            {canManage && (
              <div className="actions">
                <button type="submit" className="primary" disabled={busy || !shown.name.trim()}>
                  {t('organizationProfile.save')}
                </button>
              </div>
            )}
          </form>
        </section>
      )}
    </Page>
  );
}
