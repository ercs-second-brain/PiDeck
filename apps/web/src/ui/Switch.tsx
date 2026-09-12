import "./switch.css";

/**
 * A real checkbox rendered as a switch (`role="switch"`); the label is its
 * accessible name.
 */
export function Switch({ checked, onChange, label }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <span className="switch">
      <input
        type="checkbox"
        role="switch"
        className="switch__input"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
      />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__knob" />
      </span>
    </span>
  );
}
