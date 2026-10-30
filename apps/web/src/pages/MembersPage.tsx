import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useConfirm, useToast } from '../feedback';
import { useErrorMessage } from '../session';
import { Badge, ErrorText, Field, Page } from '../ui';
import { Avatar } from './cases/PartyCard';

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
  const toast = useToast();
  const confirm = useConfirm();
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
    if (status === 'DISABLED') {
      const ok = await confirm({
        title: t('members.confirmDisable', { name: m.fullName }),
        body: t('members.confirmDisableBody'),
        confirmLabel: t('members.disable'),
        danger: true,
      });
      if (!ok) return;
    }
    const done = await run(() => api('POST', `/organization/members/${m.userId}`, { status }));
    if (done !== undefined) toast(t('toast.saved'));
    await refresh();
  }

  async function link(m: Member, kind: 'invite' | 'password-reset') {
    const res = await run(() =>
      api<{ url: string }>('POST', `/organization/members/${m.userId}/${kind}`),
    );
    if (res) setNotice({ text: t('members.linkReady'), url: res.url });
  }

  const memberList = (
    <section className="card static">
      <h2 className="card-title">{t('members.list', { count: members.data?.length ?? 0 })}</h2>
      <ul className="member-rows">
        {members.data?.map((m) => (
          <li key={m.userId} className={m.status === 'DISABLED' ? 'disabled' : undefined}>
            <Avatar name={m.fullName} legal={false} />
            <span className="party-title">
              <strong>{m.fullName}</strong>
              <span className="muted">{m.email}</span>
              <span className="chips left">
                {m.roles.map((r) => (
                  <span key={r} className="chip chip-role">
                    {t(`roles.${r}`)}
                  </span>
                ))}
                {m.permissions.map((p) => (
                  <span key={p} className="chip chip-permission">
                    {t(`permissions.${p}`)}
                  </span>
                ))}
              </span>
            </span>
            <span className="member-side">
              {m.status === 'DISABLED' ? (
                <Badge kind="not_started">{t('members.statusDisabled')}</Badge>
              ) : m.userStatus === 'INVITED' ? (
                <Badge kind="review_required">{t('members.statusInvited')}</Badge>
              ) : (
                <Badge kind="completed">{t('members.statusActive')}</Badge>
              )}
              {canManage && (
                <span className="actions">
                  {m.userStatus === 'INVITED' && m.status === 'ACTIVE' && (
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => void link(m, 'invite')}
                    >
                      {t('members.reinvite')}
                    </button>
                  )}
                  {m.userStatus === 'ACTIVE' && m.status === 'ACTIVE' && (
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => void link(m, 'password-reset')}
                    >
                      {t('members.resetPassword')}
                    </button>
                  )}
                  {m.status === 'ACTIVE' ? (
                    <button
                      type="button"
                      className="danger small"
                      onClick={() => void setStatus(m, 'DISABLED')}
                    >
                      {t('members.disable')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="small"
                      onClick={() => void setStatus(m, 'ACTIVE')}
                    >
                      {t('members.enable')}
                    </button>
                  )}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <Page title={t('members.title')} wide>
      <ErrorText message={error} />
      {notice && (
        <section className="card static notice-card" role="status">
          <p>{notice.text}</p>
          {notice.url && (
            <div className="actions">
              <code className="wrap">{notice.url}</code>
              <button
                type="button"
                className="small"
                onClick={() => {
                  void navigator.clipboard.writeText(notice.url!);
                  toast(t('common.copied'));
                }}
              >
                {t('common.copy')}
              </button>
            </div>
          )}
        </section>
      )}
      <div className={canManage ? 'members-layout' : undefined}>
        {memberList}
        {canManage && (
          <form onSubmit={add} className="card static stack members-form">
            <h2 className="card-title">{t('members.add')}</h2>
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
            <div className="actions">
              <button type="submit" className="primary" disabled={roles.length === 0}>
                {t('members.submit')}
              </button>
            </div>
          </form>
        )}
      </div>
    </Page>
  );
}
