import "./field.css";

export interface FieldOption {
  value: string;
  label: string;
}

/**
 * Labelled input or select: text / number / password / select, 36px tall
 * (40px and 16px font on touch to prevent iOS zoom). Errors render inline
 * under the control in `--red` — never as alerts. The value is always a
 * string, even for `type: "number"`; consumers parse.
 */
export function Field({ type = "text", value, onChange, options, placeholder, disabled, min, max, step, error, label }: {
  type?: "text" | "password" | "number" | "select";
  value: string;
  onChange: (value: string) => void;
  options?: readonly FieldOption[];
  placeholder?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  error?: string;
  label?: string;
}) {
  const shared = {
    className: "field__control",
    value,
    disabled,
    placeholder,
    "aria-label": label,
    "aria-invalid": error !== undefined || undefined,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
  };
  return (
    <div className="field">
      {type === "select" ? (
        <select {...shared}>
          {(options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <input {...shared} type={type} min={min} max={max} step={step} />
      )}
      {error !== undefined && <div className="field__error">{error}</div>}
    </div>
  );
}
