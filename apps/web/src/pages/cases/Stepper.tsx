import type { CaseStep, StepProgress } from '@skydra/shared';
import { useTranslation } from 'react-i18next';

/** Where the case stands: six steps, each done, current, waiting or blocked. */
export function Stepper(props: { steps: StepProgress[]; onSelect: (step: CaseStep) => void }) {
  const { t } = useTranslation();
  return (
    <ol className="stepper" aria-label={t('casePage.steps.TRANSACTION')}>
      {props.steps.map((s, i) => (
        <li key={s.step} className={`step step-${s.state}`}>
          <button
            type="button"
            onClick={() => props.onSelect(s.step)}
            aria-current={s.state === 'current' ? 'step' : undefined}
          >
            <span className="step-dot" aria-hidden="true">
              {s.state === 'done' ? '✓' : s.state === 'blocked' ? '!' : i + 1}
            </span>
            <span className="step-text">
              <span className="step-name">{t(`casePage.steps.${s.step}`)}</span>
              <span className="step-state">{t(`casePage.stepStates.${s.state}`)}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
