/**
 * Placeholder primitives standing in for the shared set in `src/ui/` while
 * that lands in parallel. Names and props follow docs/DESIGN.md §4; markup is
 * deliberately minimal and unstyled (inline tokens only), and this file is
 * deleted once the real primitives exist — only the import lines change.
 */

import type { ChangeEvent, HTMLAttributes, ReactNode } from "react";

const dim = { color: "var(--text-dim)" };
const errorText = { color: "var(--red)" };

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main style={{ maxWidth: 640, padding: 24, boxSizing: "border-box" }}>
      <h1 style={{ fontSize: 22, margin: 0 }}>{title}</h1>
      {children}
    </main>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1, margin: 0 }}>
        {title}
      </h2>
      {description ? <p style={{ ...dim, fontSize: 13 }}>{description}</p> : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  type = "text",
  value,
  onChange,
  placeholder,
  error,
  disabled,
}: {
  label: string;
  type?: "text" | "password";
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string | null;
  disabled?: boolean;
}) {
  function handle(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.value);
  }
  return (
    <label style={{ display: "block", marginTop: 12 }}>
      <span style={{ ...dim, fontSize: 12, display: "block", marginBottom: 4 }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={handle}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        style={{
          display: "block",
          width: "100%",
          boxSizing: "border-box",
          height: 36,
          background: "var(--bg-hover)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "0 10px",
        }}
      />
      {error ? <span style={{ ...errorText, fontSize: 12 }}>{error}</span> : null}
    </label>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span style={{ fontSize: 13 }}>{label}</span>
    </label>
  );
}

export function Button({
  variant = "default",
  busy = false,
  disabled = false,
  onClick,
  children,
}: {
  variant?: "default" | "primary" | "danger" | "ghost";
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-variant={variant}
      disabled={disabled || busy}
      onClick={onClick}
      style={{
        height: 36,
        padding: "0 14px",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: variant === "primary" ? "var(--accent)" : "transparent",
        color: variant === "primary" ? "#0c0d10" : "var(--text)",
        cursor: disabled || busy ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function Badge({
  tone = "dim",
  children,
  ...rest
}: { tone?: "dim" | "accent" | "green" | "red"; children: ReactNode } & HTMLAttributes<HTMLSpanElement>) {
  const color =
    tone === "green" ? "var(--green)" : tone === "red" ? "var(--red)" : tone === "accent" ? "var(--accent)" : "var(--text-dim)";
  return (
    <span
      {...rest}
      style={{
        display: "inline-block",
        fontSize: 11,
        lineHeight: "22px",
        padding: "0 10px",
        borderRadius: 999,
        border: `1px solid ${color}`,
        color,
      }}
    >
      {children}
    </span>
  );
}
