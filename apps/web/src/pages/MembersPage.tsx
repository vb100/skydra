import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useErrorMessage } from '../session';
import { ErrorText, Field, Page } from '../ui';

type Member = {
  userId: string;
  email: string;
  fullName: string;
  userStatus: 'INVITED' | 'ACTIVE' | 'DISABLED';
  roles: string[];
  permissions: string[];
  status: 'ACTIVE' | 'DISABLED';
};

const ROLES = ['ORG_ADMIN', 'MANAGER', 'BROKER'] as const;
const PERMISSIONS = ['AML_OFFICER', 'APPROVER', 'CASE_VIEW_ALL'] as const;

function Checkboxes<T extends string>(props: {
  legend: string;
  options: readonly T[];
  label: (v: T) => string;
  value: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <fieldset className="field">
      <legend>{props.legend}</legend>
      {props.options.map((o) => (
        <label key={o} className="check">
          <input
            type="checkbox"
            checked={props.value.includes(o)}
            onChange={(e) =>
              props.onChange(
                e.target.checked ? [...props.value, o] : props.value.filter((v) => v !== o),
              )
            }
          />
          {props.label(o)}
        </label>
      ))}
    </fieldset>
  );
}

export function MembersPage({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<Member[]>('GET', '/organization/members'),
  });
  const [form, setForm] = useState({ email: '', fullName: '' });
  const [roles, setRoles] = useState<(typeof ROLES)[number][]>(['BROKER']);
  const [permissions, setPermissions] = useState<(typeof PERMISSIONS)[number][]>([]);
  const [notice, setNotice] = useState<{ text: string; url?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members'] });

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    setNotice(null);
    try {
      return await action();
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const res = await run(() =>
      api<{ inviteUrl: string | null }>('POST', '/organization/members', {
        ...form,
        roles,
        permissions,
      }),
    );
    if (!res) return;
    setNotice(
      res.inviteUrl
        ? { text: t('members.inviteReady'), url: res.inviteUrl }
        : { text: t('members.addedExisting') },
    );
    setForm({ email: '', fullName: '' });
    await refresh();
  }

  async function setStatus(m: Member, status: 'ACTIVE' | 'DISABLED') {
    await run(() => api('POST', `/organization/members/${m.userId}`, { status }));
    await refresh();
  }

  async function link(m: Member, kind: 'invite' | 'password-reset') {
    const res = await run(() =>
      api<{ url: string }>('POST', `/organization/members/${m.userId}/${kind}`),
    );
    if (res) setNotice({ text: t('members.linkReady'), url: res.url });
  }

  return (
    <Page title={t('members.title')}>
      <ErrorText message={error} />
      {notice && (
        <section className="card static" role="status">
          <p>{notice.text}</p>
          {notice.url && (
            <>
              <code className="wrap">{notice.url}</code>
              <button
                type="button"
                className="secondary"
                onClick={() => void navigator.clipboard.writeText(notice.url!)}
              >
                {t('common.copy')}
              </button>
            </>
          )}
        </section>
      )}
      <ul className="list">
        {members.data?.map((m) => (
          <li key={m.userId} className="card static">
            <strong>{m.fullName}</strong>
            <span className="muted">{m.email}</span>
            <span>{m.roles.map((r) => t(`roles.${r}`)).join(', ')}</span>
            {m.permissions.length > 0 && (
              <span className="muted">
                {m.permissions.map((p) => t(`permissions.${p}`)).join(', ')}
              </span>
            )}
            {m.status === 'DISABLED' ? (
              <span className="muted">{t('members.statusDisabled')}</span>
            ) : (
              m.userStatus === 'INVITED' && (
                <span className="muted">{t('members.statusInvited')}</span>
              )
            )}
            {canManage && (
              <div className="actions">
                {m.status === 'ACTIVE' ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void setStatus(m, 'DISABLED')}
                  >
                    {t('members.disable')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void setStatus(m, 'ACTIVE')}
                  >
                    {t('members.enable')}
                  </button>
                )}
                {m.userStatus === 'INVITED' && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void link(m, 'invite')}
                  >
                    {t('members.reinvite')}
                  </button>
                )}
                {m.userStatus === 'ACTIVE' && m.status === 'ACTIVE' && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void link(m, 'password-reset')}
                  >
                    {t('members.resetPassword')}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <>
          <h2>{t('members.add')}</h2>
          <form onSubmit={add} className="stack">
            <Field
              label={t('members.email')}
              name="email"
              type="email"
              inputMode="email"
              value={form.email}
              onChange={(v) => setForm({ ...form, email: v })}
            />
            <Field
              label={t('members.fullName')}
              name="fullName"
              value={form.fullName}
              onChange={(v) => setForm({ ...form, fullName: v })}
            />
            <Checkboxes
              legend={t('members.roles')}
              options={ROLES}
              label={(r) => t(`roles.${r}`)}
              value={roles}
              onChange={setRoles}
            />
            <Checkboxes
              legend={t('members.permissions')}
              options={PERMISSIONS}
              label={(p) => t(`permissions.${p}`)}
              value={permissions}
              onChange={setPermissions}
            />
            <button type="submit" className="primary" disabled={roles.length === 0}>
              {t('members.submit')}
            </button>
          </form>
        </>
      )}
    </Page>
  );
}
