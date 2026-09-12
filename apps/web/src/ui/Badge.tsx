import type { ReactNode } from "react";
import "./badge.css";

export type BadgeTone = "blue" | "amber" | "purple" | "green" | "red" | "dim";

/**
 * The state pill: text label in the state's colour tint, 11px, pill radius.
 */
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
