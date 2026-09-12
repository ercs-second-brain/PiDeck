/**
 * The app's tiny history router: no dependency, just pathname parsing plus a
 * pushState/popstate sync. `navigate()` pushes a new entry (so browser back
 * returns to the list on mobile); `useRoute()` re-renders on both.
 */

import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "session"; id: string }
  | { name: "onboarding" }
  | { name: "settings" }
  | { name: "projectSettings"; id: string };

function parsePath(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "sessions" && typeof parts[1] === "string") return { name: "session", id: parts[1] };
  if (parts[0] === "onboarding") return { name: "onboarding" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "projects" && typeof parts[1] === "string" && parts[2] === "settings") {
    return { name: "projectSettings", id: parts[1] };
  }
  return { name: "home" };
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(to: string): void {
  if (window.location.pathname === to) return;
  window.history.pushState({}, "", to);
  for (const listener of listeners) listener();
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname);
  return parsePath(pathname);
}
