import { z } from 'zod';
import type { ChecklistItem } from './kyc';

/** The broker's path through a case, as shown in the step bar. */
export const CaseStep = z.enum([
  'TRANSACTION',
  'PARTIES',
  'SCREENING',
  'IDENTITY',
  'RISK',
  'COMPLETION',
]);
export type CaseStep = z.infer<typeof CaseStep>;

/** Which step each checklist item belongs to. */
export const STEP_OF_ITEM: Record<ChecklistItem, CaseStep> = {
  PARTIES_ADDED: 'PARTIES',
  OWNERSHIP_FETCHED: 'PARTIES',
  OWNERSHIP_RESOLVED: 'PARTIES',
  UBOS_LINKED: 'PARTIES',
  SCREENED: 'SCREENING',
  MATCHES_REVIEWED: 'SCREENING',
  NO_CONFIRMED_SANCTIONS: 'SCREENING',
  IDENTITY_VERIFIED: 'IDENTITY',
  CDD_COMPLETED: 'IDENTITY',
  RISK_ASSESSED: 'RISK',
  EDD_APPROVED: 'RISK',
  APPROVAL_NOT_REJECTED: 'RISK',
  NO_OPEN_ESCALATION: 'COMPLETION',
};

/** Items that stop the transaction rather than wait for the next step. */
export const BLOCKING_ITEMS: readonly ChecklistItem[] = [
  'NO_CONFIRMED_SANCTIONS',
  'APPROVAL_NOT_REJECTED',
  'NO_OPEN_ESCALATION',
];

export type ChecklistResult = { casePartyId: string | null; item: ChecklistItem; ok: boolean };
export type StepState = 'done' | 'current' | 'todo' | 'blocked';
export type StepProgress = { step: CaseStep; state: StepState; missing: ChecklistResult[] };

const ITEM_ORDER: readonly ChecklistItem[] = Object.keys(STEP_OF_ITEM) as ChecklistItem[];

/**
 * Step states from the checklist (app.case_checklist), so the step bar always agrees with the
 * compliance status. A step is done when nothing in it or before it is missing, blocked when a
 * stopping condition is in it; the first step with missing items is the current one.
 */
export function caseSteps(checklist: readonly ChecklistResult[]): StepProgress[] {
  let currentFound = false;
  // A step counts as done only when every earlier step is done too: a case without parties has
  // nothing missing in "screening", but screening has not happened.
  let allDoneSoFar = true;
  return CaseStep.options.map((step) => {
    const missing = checklist.filter((e) => !e.ok && STEP_OF_ITEM[e.item] === step);
    let state: StepState;
    if (missing.some((e) => BLOCKING_ITEMS.includes(e.item))) state = 'blocked';
    else if (missing.length === 0 && allDoneSoFar) state = 'done';
    else if (!currentFound && missing.length > 0) {
      state = 'current';
      currentFound = true;
    } else state = 'todo';
    if (state !== 'done') allDoneSoFar = false;
    return { step, state, missing };
  });
}

/**
 * The one thing to do next: a stopping condition first, otherwise the earliest missing item of
 * the earliest unfinished step. Null when the case is complete.
 */
export function nextStep(checklist: readonly ChecklistResult[]): ChecklistResult | null {
  const missing = checklist.filter((e) => !e.ok);
  const blocking = missing.find((e) => BLOCKING_ITEMS.includes(e.item));
  if (blocking) return blocking;
  const rank = (e: ChecklistResult) =>
    CaseStep.options.indexOf(STEP_OF_ITEM[e.item]) * 100 + ITEM_ORDER.indexOf(e.item);
  return [...missing].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
