import type { MouseEventHandler, ReactNode } from "react";
import "./button.css";

/**
 * The one button: `default` for normal actions, `primary` for the main
 * action on a screen, `danger` for destructive ones, `ghost` for quiet
 * affordances.
 */
export function Button({ variant = "default", type = "button", disabled, autoFocus, onClick, children }: {
  variant?: "default" | "primary" | "danger" | "ghost";
  type?: "button" | "submit";
  disabled?: boolean;
  autoFocus?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <button type={type} className={`btn btn--${variant}`} disabled={disabled} autoFocus={autoFocus} onClick={onClick}>
      {children}
    </button>
  );
}
