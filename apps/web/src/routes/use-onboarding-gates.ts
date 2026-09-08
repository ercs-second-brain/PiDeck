import { useEffect, useRef, useState } from "react";
import { apiGetOnboardingState } from "../lib/api";
import { shouldAutoOpenOnboarding } from "../terminal/sidebar";

/**
 * The onboarding gates (issues #62, #90, #183): when the two onboarding
 * modals open. The PiDeck-global flow (pi/gh auth) opens whenever the
 * daemon reports pi without a ready provider — first run or a later
 * re-config need; the project wizard opens once on a first run with zero
 * projects (the sidebar "+" and the empty-state CTA stay available for
 * every later need). While the global flow is open the first-run auto-open
 * is skipped: finishing the global flow chains into the project wizard
 * itself when there is no project yet.
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
  const { loaded, error, entryCount } = state;

  // Issue #90: "zero projects" only counts after the project list actually
  // loaded — the pre-load empty state must not open the wizard.
  useEffect(() => {
    if (!autoOpened.current && !globalOpen && shouldAutoOpenOnboarding({ loaded, error, entryCount })) {
      autoOpened.current = true;
      setProjectOpen(true);
    }
  }, [globalOpen, loaded, error, entryCount]);

  // Issue #183: probe the shared onboarding state once.
  useEffect(() => {
    apiGetOnboardingState()
      .then((onboarding) => {
        if (onboarding.piAuth.ready !== true) setGlobalOpen(true);
      })
      .catch(() => {});
  }, []);

  return {
    projectOpen,
    globalOpen,
    openProject: () => {
      autoOpened.current = true;
      setProjectOpen(true);
    },
    closeProject: () => setProjectOpen(false),
    closeGlobal: () => setGlobalOpen(false),
    finishGlobal: () => {
      setGlobalOpen(false);
      autoOpened.current = true;
      // First run: chain straight into project onboarding.
      if (entryCount === 0) setProjectOpen(true);
    },
  };
}
