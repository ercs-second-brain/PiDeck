import type { ReactNode } from "react";

/**
 * The step-shell every wizard panel renders into: a titled
 * `section.wizard-panel` inside the modal card. Steps own their content
 * (probe state, forms, actions); this keeps the frame identical.
 */
export function StepPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="wizard-panel">
      <h2 className="panel-title">{title}</h2>
      {children}
    </section>
  );
}
