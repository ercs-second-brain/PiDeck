import "./header.css";

/**
 * The 44px app header: sidebar toggle (desktop) or back (mobile detail
 * views) plus the current context on the left; "+" (onboarding) and the
 * settings gear on the right.
 */
export function Header({ context, detail, collapsed, onToggle, onNavigate }: {
  context: string | null;
  detail: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: (path: string) => void;
}) {
  return (
    <header className={`header${detail ? " header--detail" : ""}`}>
      <div className="header__side">
        <button
          type="button"
          className="header__icon header__toggle"
          aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
          onClick={onToggle}
        >
          ☰
        </button>
        <button type="button" className="header__icon header__back" aria-label="Back to sessions" onClick={() => onNavigate("/")}>
          ←
        </button>
        {context === null ? (
          <span className="header__brand">
            <span className="header__brand-dot" aria-hidden="true" />
            PiDeck
          </span>
        ) : (
          <span className="header__context">{context}</span>
        )}
      </div>
      <div className="header__actions">
        <button type="button" className="header__icon" aria-label="Add project" onClick={() => onNavigate("/onboarding")}>
          +
        </button>
        <button type="button" className="header__icon" aria-label="Settings" onClick={() => onNavigate("/settings")}>
          ⚙
        </button>
      </div>
    </header>
  );
}
