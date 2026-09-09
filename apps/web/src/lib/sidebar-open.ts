/**
 * Sidebar visibility persistence for the app shell (issue #326): the
 * the toggle controls the sidebar — a drawer on mobile (≤768px, existing #93
 * behavior), a slide-off/slide-back collapse on desktop — and the state
 * persists in localStorage so it survives reloads. Default is open on
 * desktop, closed on mobile (the drawer starts shut).
 *
 * Issue #354: the collapse is manual-only on desktop. Auto-closing is a
 * mobile-drawer behavior (see {@link shouldAutoCloseSidebar}).
 *
 * Issue #364: the state is per-viewport — a separate localStorage key for
 * the mobile drawer and the desktop sidebar — so a mobile navigation
 * (drawer auto-close) can never persist "closed" over the desktop's
 * manually-chosen open state.
 *
 * Storage access is injected and optional so the shell still renders (and
 * unit-tests render) in non-browser environments: failures to read or write
 * simply fall back to the viewport default (same pattern as
 * ./sidebar-collapse.ts).
 */

const DESKTOP_OPEN_KEY = "pideck.sidebar.open.desktop";
const MOBILE_OPEN_KEY = "pideck.sidebar.open.mobile";
/**
 * Pre-#364 storage: one shared key for both viewports. Kept as a one-time
 * desktop fallback so an existing desktop choice survives the upgrade; on
 * mobile the old value is deliberately ignored — under the shared-key
 * scheme the drawer's auto-close also wrote here, so it is ambiguous.
 */
const LEGACY_OPEN_KEY = "pideck.sidebar.open";

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
  return !isMobileViewport();
}

/** True when the current viewport is at or below the mobile drawer breakpoint. */
export function isMobileViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(SIDEBAR_DRAWER_QUERY).matches
  );
}

/**
 * Issue #354: whether a side effect (navigation, opening a settings modal)
 * may auto-close the sidebar. On the mobile drawer it must — a drawer left
 * open would cover the new main-pane view. On desktop the user's choice is
 * respected: if they opened the sidebar it stays open, if they closed it it
 * stays closed — only the sidebar's own toggle (or the breakpoint crossing
 * into mobile) changes it.
 */
export function shouldAutoCloseSidebar(mobileViewport: boolean): boolean {
  return mobileViewport;
}

/** The storage key owning this viewport's open state (issue #364). */
function openKey(mobile: boolean): string {
  return mobile ? MOBILE_OPEN_KEY : DESKTOP_OPEN_KEY;
}

/** Reads a "0"/"1" flag; returns undefined for junk/absent values. */
function readFlag(readFrom: StorageLike, key: string): boolean | undefined {
  try {
    const raw = readFrom.getItem(key);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    // Fall through to the viewport default.
  }
  return undefined;
}

/** Reads the persisted sidebar-open state; tolerant of junk/absent storage. */
export function loadSidebarOpen(store?: StorageLike): boolean {
  const readFrom = store ?? storage();
  const mobile = isMobileViewport();
  if (readFrom) {
    const own = readFlag(readFrom, openKey(mobile));
    if (own !== undefined) return own;
    // One-time legacy fallback (issue #364): desktop only, since the shared
    // pre-#364 value could have been written by the mobile drawer too.
    if (!mobile) {
      const legacy = readFlag(readFrom, LEGACY_OPEN_KEY);
      if (legacy !== undefined) return legacy;
    }
  }
  return defaultSidebarOpen();
}

/** Persists the sidebar-open state; failures (quota, privacy mode) are silent. */
export function saveSidebarOpen(open: boolean, store?: StorageLike): void {
  const writeTo = store ?? storage();
  if (!writeTo) return;
  try {
    writeTo.setItem(openKey(isMobileViewport()), open ? "1" : "0");
  } catch {
    // Non-fatal: the state just won't persist.
  }
}
