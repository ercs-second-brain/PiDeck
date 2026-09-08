/** The wizard's step keys, in flow order. */
export type Step = "pi" | "permission" | "source" | "autoagent";

const STEP_LABELS: Array<{ key: Step; label: string }> = [
  { key: "pi", label: "1 · pi agent" },
  { key: "permission", label: "2 · gh access" },
  { key: "source", label: "3 · repository" },
  { key: "autoagent", label: "4 · auto-agents" },
];

/** The wizard's step indicator strip: current step highlighted, earlier ones marked done. */
export function StepNav({ step }: { step: Step }) {
  const stepIndex = STEP_LABELS.findIndex((s) => s.key === step);
  return (
    <ol className="wizard-steps">
      {STEP_LABELS.map((entry, index) => (
        <li
          key={entry.key}
          className={`wizard-step ${entry.key === step ? "current" : ""} ${index < stepIndex ? "done" : ""}`}
        >
          {entry.label}
        </li>
      ))}
    </ol>
  );
}
