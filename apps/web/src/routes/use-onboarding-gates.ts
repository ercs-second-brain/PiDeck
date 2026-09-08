import { useEffect, useRef, useState } from "react";
import { apiGetOnboardingState, apiGetPiAuth, type OnboardingState } from "../lib/api";
import { shouldAutoOpenOnboarding } from "../terminal/sidebar";

/**
 * Whether the global PiDeck onboarding (pi + gh auth) can be skipped
 * (issue #209): either live probe set reports ready — the daemon probes
 * are the authority — or the shell onboarding's recorded results
 * (`onboarding.json`, issue #165) say it already completed both, the
 * fallback for a machine whose probes fail or lag behind its history.
 */
export function globalOnboardingDone(state: OnboardingState): boolean {
  if (state.piAuth.ready && state.ghAuth.authenticated) return true;
  const recorded = state.recorded;
  return recorded?.pi.authStatus === "ready" && recorded?.gh.authStatus === "ready";
}

/**
 * The onboarding gates (issues #62, #90, #183, #209): when the two
 * onboarding modals open. The order is strict — global PiDeck onboarding
 * (pi/gh auth) first, project onboarding second, never both at once. The
 * global flow is skipped entirely when the daemon's probes report ready
 * or the recorded shell onboarding says done ({@link globalOnboardingDone}),
 * so a fully-configured machine opens zero modals; the project wizard
 * auto-opens once on a first run with zero projects, only after the
 * global gate is done (the sidebar "+" and the empty-state CTA stay
 * available for every later need).
 */
export function useOnboardingGates(state: { loaded: boolean; error: string | null; entryCount: number }): {
  projectOpen: boolean;
  globalOpen: boolean;
  openProject: () => void;
  closeProject: () => void;
  closeGlobal: () => void;
  finishGlobal: () => void;
} {
  const [projectOpen, setProjectOpen] = useState(false);
  const [globalOpen, setGlobalOpen] = useState(false);
  const autoOpened = useRef(false);
  const [gates, setGates] = useState<{ resolved: boolean; globalDone: boolean }>({ resolved: false, globalDone: false });
  const { loaded, error, entryCount } = state;

  // Issues #183/#209: resolve the shared onboarding state once, before any
  // gate acts. A failed read (e.g. an older daemon without /api/onboarding)
  // degrades to the pi-auth probe alone; a failed probe too keeps the
  // global flow owed (its step offers the recheck).
  useEffect(() => {
    apiGetOnboardingState()
      .then((onboarding) => setGates({ resolved: true, globalDone: globalOnboardingDone(onboarding) }))
      .catch(() => {
        apiGetPiAuth()
          .then((pi) => setGates({ resolved: true, globalDone: pi.ready }))
          .catch(() => setGates({ resolved: true, globalDone: false }));
      });
  }, []);

  // Issue #90: "zero projects" only counts after the project list actually
  // loaded — and (issue #209) only after the global gate resolved and is
  // done: while the global flow is still owed, finishing it chains into
  // the project wizard instead (finishGlobal).
  useEffect(() => {
    if (autoOpened.current || !gates.resolved || !gates.globalDone) return;
    if (shouldAutoOpenOnboarding({ loaded, error, entryCount })) {
      autoOpened.current = true;
      setProjectOpen(true);
    }
  }, [gates.resolved, gates.globalDone, loaded, error, entryCount]);

  return {
    projectOpen,
    globalOpen,
    openProject: () => {
      // Issue #209: a project cannot be onboarded before PiDeck itself is
      // configured — while the global gate is not done, the sidebar "+"
      // and empty-state CTA lead to the global flow first.
      if (gates.resolved && !gates.globalDone) {
        setGlobalOpen(true);
        return;
      }
      autoOpened.current = true;
      setGlobalOpen(false);
      setProjectOpen(true);
    },
    closeProject: () => setProjectOpen(false),
    closeGlobal: () => setGlobalOpen(false),
    finishGlobal: () => {
      setGlobalOpen(false);
      setGates((g) => ({ ...g, globalDone: true }));
      autoOpened.current = true;
      // First run: chain straight into project onboarding.
      if (entryCount === 0) setProjectOpen(true);
    },
  };
}
