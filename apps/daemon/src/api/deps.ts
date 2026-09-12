import type { PiProbe, Probe } from "@pideck/shared";
import type { Tmux } from "../sessions/tmux.js";
import type { SessionRegistry } from "../sessions/registry.js";
import type { PromptOverrides } from "../prompts/overrides.js";
import type { GlobalSettingsStore } from "../store/globalSettingsStore.js";
import type { ProjectStore } from "../store/projectStore.js";
import type { ProjectFacts } from "../reconciler/index.js";
import type { Trace } from "../reconciler/trace.js";
import type { ReviewLoginFlow } from "./onboarding.js";
import type { Updater } from "./update.js";

/**
 * Everything the API layer needs, injected so an in-memory daemon can be
 * assembled for tests. Every store here is already built and loaded by the
 * time the HTTP server starts.
 */
export interface DaemonDeps {
  version: string;
  stateDir: string;
  pollIntervalSeconds: number;
  projects: ProjectStore;
  settings: GlobalSettingsStore;
  registry: SessionRegistry;
  tmux: Tmux;
  prompts: PromptOverrides;
  updates: Updater;
  ghPrimary: () => Promise<Probe>;
  ghReview: () => Promise<Probe>;
  pi: () => Promise<PiProbe>;
  /** The review account's device-code login flow. */
  reviewLogin: ReviewLoginFlow;
  /** The reconciler's last GitHub read pass for a project; null before the first. */
  reconcilerFacts?: (projectId: string) => ProjectFacts | null;
  /** The reconciler's GitHub throttle/error state, for Status. */
  githubStatus?: () => { throttledUntil: string | null; lastError: string | null };
  /** The per-session trace, shared with the reconciler's apply path. */
  trace: Trace;
  /** Called after an API mutation changes the session registry. */
  notifyChange?: () => void;
}