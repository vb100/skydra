import type { ChecklistResult, ScreeningStatus } from '@skydra/shared';
import { useTranslation } from 'react-i18next';
import { OwnershipPanel } from './OwnershipPanel';
import { PartyKycPanel } from './PartyKycPanel';
import type { CaseParty, IdentityVerification, OwnershipView, Run } from './types';

type ChipState = 'ok' | 'attention' | 'missing' | 'pep' | 'blocked';

/** The screening colour as a chip: green, yellow, orange (PEP), red (sanctions). */
const SCREENING_CHIP: Record<ScreeningStatus, ChipState> = {
  NOT_SCREENED: 'missing',
  FAILED: 'attention',
  GREEN: 'ok',
  YELLOW: 'attention',
  ORANGE: 'pep',
  RED: 'blocked',
};

/**
 * Status chips of a party from its checklist entries; a chip is shown only if it applies. The
 * screening chip carries the person's screening colour when it is known.
 */
export function partyChips(
  casePartyId: string,
  checklist: readonly ChecklistResult[],
  screening?: ScreeningStatus,
) {
  const mine = checklist.filter((e) => e.casePartyId === casePartyId);
  const has = (item: ChecklistResult['item']) => mine.find((e) => e.item === item);
  const chips: { key: string; state: ChipState; status?: ScreeningStatus }[] = [];
  const screened = has('SCREENED');
  if (screened)
    chips.push(
      screening
        ? { key: 'screening', state: SCREENING_CHIP[screening], status: screening }
        : {
            key: 'screening',
            state: !screened.ok
              ? 'missing'
              : has('MATCHES_REVIEWED')?.ok === false
                ? 'attention'
                : 'ok',
          },
    );
  const fetched = has('OWNERSHIP_FETCHED');
  if (fetched)
    chips.push({
      key: 'registry',
      state: !fetched.ok
        ? 'missing'
        : has('OWNERSHIP_RESOLVED')?.ok === false || has('UBOS_LINKED')?.ok === false
          ? 'attention'
          : 'ok',
    });
  const identity = has('IDENTITY_VERIFIED');
  if (identity) chips.push({ key: 'identity', state: identity.ok ? 'ok' : 'missing' });
  const cdd = has('CDD_COMPLETED');
  if (cdd) chips.push({ key: 'cdd', state: cdd.ok ? 'ok' : 'missing' });
  return chips;
}

/** A person's screening colour as one chip with its label. */
export function ScreeningBadge({ status }: { status: ScreeningStatus }) {
  const { t } = useTranslation();
  const state = SCREENING_CHIP[status];
  return (
    <span className={`chip chip-${state}`}>
      <span aria-hidden="true">{MARK[state]}</span> {t(`screening.statuses.${status}`)}
    </span>
  );
}

const MARK: Record<ChipState, string> = {
  ok: '✓',
  attention: '!',
  missing: '○',
  pep: '!',
  blocked: '■',
};

export function StatusChips(props: {
  casePartyId: string;
  checklist: readonly ChecklistResult[];
  screening?: ScreeningStatus;
}) {
  const { t } = useTranslation();
  return (
    <span className="chips">
      {partyChips(props.casePartyId, props.checklist, props.screening).map((c) => {
        const state = c.status ? t(`screening.statuses.${c.status}`) : t(`partyStatus.${c.state}`);
        return (
          <span key={c.key} className={`chip chip-${c.state}`} title={state}>
            <span aria-hidden="true">{MARK[c.state]}</span> {t(`partyStatus.${c.key}`)}
            <span className="sr-only"> – {state}</span>
          </span>
        );
      })}
    </span>
  );
}

export function Avatar({ name, legal }: { name: string; legal: boolean }) {
  const initials = name
    .replace(/[„“"]/g, '')
    .split(/\s+/)
    .filter((w) => w && !(legal && /^(UAB|AB|MB|VšĮ|IĮ)$/i.test(w)))
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <span className={`avatar ${legal ? 'avatar-legal' : ''}`} aria-hidden="true">
      {initials || '?'}
    </span>
  );
}

/**
 * One party of the case, collapsed to a single row with its status; expanded it shows identity,
 * KYC and registry data. A company's beneficial owners are listed inside its card.
 */
export function PartyCard(props: {
  caseId: string;
  caseParty: CaseParty;
  owners: CaseParty[];
  checklist: readonly ChecklistResult[];
  /** Screening colour of each case party, by case party id. */
  screening: Partial<Record<string, ScreeningStatus>>;
  ownership: OwnershipView | undefined;
  verifications: IdentityVerification[];
  amlApplies: boolean;
  simulated: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  run: Run;
}) {
  const { t } = useTranslation();
  const { caseParty: cp } = props;
  const legal = cp.party.partyType === 'LEGAL';

  return (
    <li id={`party-${cp.id}`} className={`card static party-card ${props.expanded ? 'open' : ''}`}>
      <button
        type="button"
        className="party-head"
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <Avatar name={cp.party.displayName} legal={legal} />
        <span className="party-title">
          <strong>{cp.party.displayName}</strong>
          <span className="muted">
            {t(`partyRoles.${cp.role}`)}
            {cp.isOurClient && ` · ${t('parties.isOurClient')}`}
            {' · '}
            {t(`parties.${cp.party.partyType}`)}
            {cp.party.personalCodeMasked && ` · ${cp.party.personalCodeMasked}`}
            {cp.party.companyCode && ` · ${cp.party.companyCode}`}
          </span>
        </span>
        <StatusChips
          casePartyId={cp.id}
          checklist={props.checklist}
          screening={props.screening[cp.id]}
        />
        <span className="chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {props.expanded && (
        <div className="party-body stack">
          <span className="muted">
            {t('parties.cddScope')}: {t(`parties.cddScopes.${cp.cddScope}`)}
            {cp.reliance && ` (${cp.reliance.entityName})`}
            {cp.representedByOtherBroker && ` · ${t('parties.representedByOtherBroker')}`}
          </span>
          {props.amlApplies && legal && cp.cddScope === 'FULL' && (
            <OwnershipPanel
              caseId={props.caseId}
              casePartyId={cp.id}
              ownership={props.ownership}
              simulated={props.simulated}
              run={props.run}
            />
          )}
          {props.amlApplies && (
            <PartyKycPanel
              caseId={props.caseId}
              caseParty={cp}
              verifications={props.verifications}
              simulated={props.simulated}
              run={props.run}
            />
          )}
          <div className="actions">
            <button type="button" className="danger small" onClick={props.onRemove}>
              {t('parties.remove')}
            </button>
          </div>
        </div>
      )}

      {props.owners.length > 0 && (
        <div className="owners">
          <span className="muted">{t('partyStatus.owners', { count: props.owners.length })}</span>
          <ul>
            {props.owners.map((o) => (
              <li key={o.id} id={`party-${o.id}`}>
                <Avatar name={o.party.displayName} legal={false} />
                <span className="party-title">
                  <span>{o.party.displayName}</span>
                  <span className="muted">
                    {t(`partyRoles.${o.role}`)}
                    {o.party.personalCodeMasked && ` · ${o.party.personalCodeMasked}`}
                    {o.party.citizenships.length > 0 && ` · ${o.party.citizenships.join(', ')}`}
                  </span>
                </span>
                <StatusChips
                  casePartyId={o.id}
                  checklist={props.checklist}
                  screening={props.screening[o.id]}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
