import type { ReactNode } from "react";
import "./row.css";

/**
 * Labelled settings line: label + description on the left, control on the
 * right; stacks vertically under 480px.
 */
export function Row({ label, description, children }: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="row">
      <div className="row__text">
        <div className="row__label">{label}</div>
        {description !== undefined && <div className="row__description">{description}</div>}
      </div>
      <div className="row__control">{children}</div>
    </div>
  );
}
