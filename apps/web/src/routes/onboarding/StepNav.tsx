/** One wizard step: a key (the state machine's value) and its indicator label. */
export interface StepDef {
  key: string;
  label: string;
}

/**
 * The wizard step indicator strip: current step highlighted, completed ones
 * (earlier in the flow, or already done per the shared onboarding state —
 * issue #165) marked done. The step list is passed in because the flows
 * split at issue #183: the global onboarding owns the pi/gh steps, the
 * project wizard the source/auto-agent steps.
 */
export function StepNav({
  steps,
  step,
  doneSteps = [],
}: {
  steps: readonly StepDef[];
  step: string;
  doneSteps?: string[];
}) {
  const stepIndex = steps.findIndex((s) => s.key === step);
  return (
    <ol className="wizard-steps">
      {steps.map((entry, index) => (
        <li
          key={entry.key}
          className={`wizard-step ${entry.key === step ? "current" : ""} ${
            index < stepIndex || doneSteps.includes(entry.key) ? "done" : ""
          }`}
        >
          {entry.label}
        </li>
      ))}
    </ol>
  );
}
