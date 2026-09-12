/**
 * Placeholder primitives standing in for the shared set in `src/ui/` while
 * that lands in parallel. Names and props mirror the locked table in
 * docs/DESIGN.md §4; markup is deliberately minimal (inline tokens only), and
 * this file is deleted once the real primitives exist — only the import lines
 * change.
 */

import type { ChangeEvent, ReactNode } from "react";

const dim = { color: "var(--text-dim)" };
const errorText = { color: "var(--red)" };

export type BadgeTone = "blue" | "amber" | "purple" | "green" | "red" | "dim";

export function Page({
  title,
  subnav,
  children,
}: {
  title: string;
  subnav?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main style={{ maxWidth: 640, padding: 24, boxSizing: "border-box" }}>
      <h1 style={{ fontSize: 22, margin: 0 }}>{title}</h1>
      {subnav}
      {children}
    </main>
  );
}

export function Section({
  title,
  description,
  footer,
  children,
}: {
  title?: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={{ marginTop: 24 }}>
      {title ? (
        <h2 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1, margin: 0 }}>{title}</h2>
      ) : null}
      {description ? <p style={{ ...dim, fontSize: 13 }}>{description}</p> : null}
      {children}
      {footer}
    </section>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = "text",
  options,
  placeholder,
  disabled,
  min,
  max,
  step,
  error,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password" | "number" | "select";
  options?: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  error?: string | null;
}) {
  function handle(event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    onChange(event.target.value);
  }
  const control =
    type === "select" ? (
      <select value={value} aria-label={label} disabled={disabled} onChange={handle} style={controlStyle}>
        {(options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ) : (
      <input
        type={type}
        value={value}
        onChange={handle}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        style={controlStyle}
      />
    );
  return (
    <label style={{ display: "block", marginTop: 12 }}>
      {label ? <span style={{ ...dim, fontSize: 12, display: "block", marginBottom: 4 }}>{label}</span> : null}
      {control}
      {error ? <span style={{ ...errorText, fontSize: 12 }}>{error}</span> : null}
    </label>
  );
}

const controlStyle = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  height: 36,
  background: "var(--bg-hover)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "0 10px",
} as const;

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span style={{ fontSize: 13 }}>{label}</span>
    </label>
  );
}

export function Button({
  variant = "default",
  type = "button",
  disabled = false,
  onClick,
  children,
}: {
  variant?: "default" | "primary" | "danger" | "ghost";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      data-variant={variant}
      disabled={disabled}
      onClick={onClick}
      style={{
        height: 36,
        padding: "0 14px",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: variant === "primary" ? "var(--accent)" : "transparent",
        color: variant === "primary" ? "#0c0d10" : "var(--text)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function Badge({ tone = "blue", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 11,
        lineHeight: "22px",
        padding: "0 10px",
        borderRadius: 999,
        border: `1px solid var(--${tone === "dim" ? "text-dim" : tone})`,
        color: `var(--${tone === "dim" ? "text-dim" : tone})`,
      }}
    >
      {children}
    </span>
  );
}
