import type { ReactNode } from "react";
import "./badge.css";

export type BadgeTone = "blue" | "amber" | "purple" | "green" | "red" | "dim";

interface BadgeProps {
  tone: BadgeTone;
  /** Dot variant: an 8px circle in the tone's colour; `children` become the
   * title and accessible name instead of visible text. */
  dot?: boolean;
  children: ReactNode;
}

/** The state pill: text label in the state's colour tint, 11px, pill radius. */
export function Badge({ tone, dot = false, children }: BadgeProps) {
  if (dot) {
    const label = typeof children === "string" ? children : undefined;
    return (
      <span
        className={`badge badge--dot badge--${tone}`}
        role="img"
        title={label}
        aria-label={label}
      />
    );
  }
  return <span className={`badge badge--${tone}`}>{children}</span>;
}