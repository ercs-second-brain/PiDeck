/**
 * Collapsed-project persistence for the terminals sidebar (issue #114):
 * a per-project chevron collapses all of the project's children (worker
 * rows + the archived section); the set of collapsed projects persists in
 * localStorage so it survives reloads. Default is expanded.
 *
 * Storage access is injected and optional so the picker still renders (and
 * unit-tests render) in non-browser environments: failures to read or write
 * simply fall back to "everything expanded".
 */

const COLLAPSED_KEY = "agentskiss.sidebar.collapsedProjects";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Reads the collapsed-project id set; tolerant of junk, absent storage. */
export function loadCollapsedProjects(store?: StorageLike): Set<string> {
  const readFrom = store ?? storage();
  if (!readFrom) return new Set();
  try {
    const raw = readFrom.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/** Persists the collapsed-project id set; failures (quota, privacy mode) are silent. */
export function saveCollapsedProjects(collapsed: Set<string>, store?: StorageLike): void {
  const writeTo = store ?? storage();
  if (!writeTo) return;
  try {
    writeTo.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Non-fatal: collapse state just won't persist.
  }
}
