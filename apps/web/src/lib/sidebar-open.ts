/**
 * Sidebar visibility persistence for the app shell (issue #326): the
 * hamburger toggles the sidebar — a drawer on mobile (≤768px, existing #93
 * behavior), a slide-off/slide-back collapse on desktop — and the state
 * persists in localStorage so it survives reloads. Default is open on
 * desktop, closed on mobile (the drawer starts shut).
 *
 * Storage access is injected and optional so the shell still renders (and
 * unit-tests render) in non-browser environments: failures to read or write
 * simply fall back to the viewport default (same pattern as
 * ./sidebar-collapse.ts).
 */

const OPEN_KEY = "pideck.sidebar.open";

/** The drawer breakpoint (mirrors the ≤768px media queries in the CSS). */
export const SIDEBAR_DRAWER_QUERY = "(max-width: 768px)";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** The viewport default: open on desktop, closed (drawer shut) on mobile. */
function defaultSidebarOpen(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? true
    : !window.matchMedia(SIDEBAR_DRAWER_QUERY).matches;
}

/** Reads the persisted sidebar-open state; tolerant of junk/absent storage. */
export function loadSidebarOpen(store?: StorageLike): boolean {
  const readFrom = store ?? storage();
  if (readFrom) {
    try {
      const raw = readFrom.getItem(OPEN_KEY);
      if (raw === "0") return false;
      if (raw === "1") return true;
    } catch {
      // Fall through to the viewport default.
    }
  }
  return defaultSidebarOpen();
}

/** Persists the sidebar-open state; failures (quota, privacy mode) are silent. */
export function saveSidebarOpen(open: boolean, store?: StorageLike): void {
  const writeTo = store ?? storage();
  if (!writeTo) return;
  try {
    writeTo.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Non-fatal: the state just won't persist.
  }
}
