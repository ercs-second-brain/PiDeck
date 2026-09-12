/**
 * Tracks one async action so its triggering control can show the state:
 * busy while in flight, the saved label for two seconds, or the error
 * message inline on failure.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type ActionState = "idle" | "busy" | "saved" | "error";

const SAVED_VISIBLE_MS = 2000;

export interface TrackedAction {
  state: ActionState;
  error: string | null;
  run: (action: () => Promise<void>) => Promise<void>;
}

export function useAction(): TrackedAction {
  const [state, setState] = useState<ActionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const run = useCallback(async (action: () => Promise<void>) => {
    if (timer.current) clearTimeout(timer.current);
    setState("busy");
    setError(null);
    try {
      await action();
      setState("saved");
      timer.current = setTimeout(() => setState("idle"), SAVED_VISIBLE_MS);
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return { state, error, run };
}

export function actionLabel(
  state: ActionState,
  idle: string,
  busy: string,
  saved = "Saved",
): string {
  if (state === "busy") return busy;
  if (state === "saved") return saved;
  return idle;
}