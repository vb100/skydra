import { DiscrepancyResolution } from '@skydra/shared';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { useConfirm } from '../../feedback';
import { formatDateTime } from '../../format';
import { Field, Hint, Select } from '../../ui';
import type { OwnershipNode, OwnershipView, Run } from './types';

/** Registry data, ownership chain and beneficial owners of one legal-entity party. */
export function OwnershipPanel(props: {
  caseId: string;
  casePartyId: string;
  ownership: OwnershipView | undefined;
  simulated: boolean;
  run: Run;
}) {
  const { t } = useTranslation();
  const { caseId, casePartyId, ownership: o, simulated, run } = props;
  const fetch = () =>
    run(
      () => api('POST', `/cases/${caseId}/parties/${casePartyId}/ownership`),
      t('toast.ownershipFetched'),
    );

  return (
    <div className="match">
      <strong>{t('ownership.title')}</strong>
      {simulated && (
        <Hint summary={t('common.demoData')}>
          <p className="muted">{t('ownership.simulatedHint')}</p>
        </Hint>
      )}
      {!o ? (
        <>
          <span className="muted">{t('ownership.none')}</span>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void fetch()}>
              {t('ownership.fetch')}
            </button>
          </div>
        </>
      ) : (
        <>
          <span>
            {o.company.name} · {o.company.code}
            {o.company.legalForm && ` · ${o.company.legalForm}`}
          </span>
          {o.company.address && <span className="muted">{o.company.address}</span>}
          {o.company.manager && (
            <span className="muted">
              {t('ownership.manager', {
                name: `${o.company.manager.firstName} ${o.company.manager.lastName}`,
              })}
            </span>
          )}
          <span className="muted">
            {t('ownership.fetchedAt', {
              date: formatDateTime(o.fetchedAt),
              provider: o.provider,
            })}
          </span>

          <strong>{t('ownership.structure')}</strong>
          <Tree nodes={o.analysis.tree} />

          <strong>{t('ownership.ubos', { threshold: o.analysis.thresholdPercent })}</strong>
          <ul className="checklist">
            {o.ubos.map((u) => (
              <li key={u.key}>
                {u.person.firstName} {u.person.lastName}
                {u.person.personalCodeMasked && ` · ${u.person.personalCodeMasked}`}
                {u.person.citizenship && ` · ${u.person.citizenship}`} ·{' '}
                {t(`ownership.bases.${u.basis}`)}
                {u.effectivePercent !== null && ` ${u.effectivePercent} %`}
                <span className="muted">
                  {' · '}
                  {[
                    u.computed ? t('ownership.computed') : t('ownership.notComputed'),
                    u.declared ? t('ownership.declared') : t('ownership.notDeclared'),
                    u.linked && t('ownership.linked'),
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              </li>
            ))}
          </ul>
          {o.discrepancy && <span className="error">{t('ownership.discrepancy')}</span>}
          {o.incomplete && <span className="error">{t('ownership.incomplete')}</span>}

          {(o.discrepancy || o.incomplete) &&
            (o.resolution ? (
              <span className="muted">
                {t('ownership.resolved', {
                  resolution: t(`ownership.resolutions.${o.resolution.resolution}`),
                  notes: o.resolution.notes,
                  evidence: o.resolution.evidence,
                  by: o.resolution.resolvedByName,
                })}
              </span>
            ) : (
              <ResolveForm caseId={caseId} snapshotId={o.snapshotId} run={run} />
            ))}

          <div className="actions">
            {o.ubos.some((u) => !u.linked) && (
              <button
                type="button"
                className="primary"
                onClick={() =>
                  void run(
                    () => api('POST', `/cases/${caseId}/ownership/${o.snapshotId}/link-owners`),
                    t('toast.ownersLinked'),
                  )
                }
              >
                {t('ownership.link')}
              </button>
            )}
            <button type="button" className="ghost" onClick={() => void fetch()}>
              {t('ownership.refetch')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Tree({ nodes }: { nodes: OwnershipNode[] }) {
  const { t } = useTranslation();
  return (
    <ul className="tree">
      {nodes.map((n, i) => (
        <li key={`${n.name}-${i}`}>
          {n.name}
          {n.code && ` (${n.code}${n.country ? `, ${n.country}` : ''})`} – {n.sharePercent} %
          {n.effectivePercent !== n.sharePercent && (
            <span className="muted">
              {' '}
              · {t('ownership.effective', { percent: n.effectivePercent })}
            </span>
          )}
          {n.unresolved && <span className="error"> · {t('ownership.unresolved')}</span>}
          {n.children.length > 0 && <Tree nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}

function ResolveForm({
  caseId,
  snapshotId,
  run,
}: {
  caseId: string;
  snapshotId: string;
  run: Run;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [resolution, setResolution] = useState<DiscrepancyResolution | ''>('');
  const [notes, setNotes] = useState('');
  const [evidence, setEvidence] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await confirm({
      title: t('confirm.resolveOwnership'),
      body: t('confirm.irreversible'),
      confirmLabel: t('confirm.record'),
    });
    if (!ok) return;
    await run(
      () =>
        api('POST', `/cases/${caseId}/ownership/${snapshotId}/resolve`, {
          resolution,
          notes,
          evidence,
        }),
      t('toast.ownershipResolved'),
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      <strong>{t('ownership.resolveTitle')}</strong>
      <Select
        label={t('ownership.resolution')}
        name={`resolution-${snapshotId}`}
        options={DiscrepancyResolution.options}
        optionLabel={(v) => t(`ownership.resolutions.${v}`)}
        value={resolution}
        onChange={setResolution}
        emptyLabel=""
      />
      <Field
        label={t('ownership.notes')}
        name={`notes-${snapshotId}`}
        value={notes}
        onChange={setNotes}
      />
      <Field
        label={t('ownership.evidence')}
        name={`evidence-${snapshotId}`}
        value={evidence}
        onChange={setEvidence}
      />
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={!resolution || notes.trim().length < 20 || evidence.trim().length < 3}
        >
          {t('ownership.resolve')}
        </button>
      </div>
    </form>
  );
}
