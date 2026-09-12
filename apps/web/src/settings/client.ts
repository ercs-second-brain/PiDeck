/**
 * Thin typed wrappers over the daemon's REST endpoints, called through the
 * app's API client. Every settings screen goes through this module, so a
 * change to the client's call shape only ever lands here.
 */

import type {
  GlobalSettingsPut,
  GlobalSettingsRead,
  Ok,
  Persona,
  PiProbe,
  Project,
  ProjectSettings,
  Prompt,
  PromptPut,
  SessionView,
  Status,
  UpdateCheck,
} from "@pideck/shared";
import { api } from "../lib/api";

export const loadStatus = (): Promise<Status> => api("status");
export const loadGlobalSettings = (): Promise<GlobalSettingsRead> => api("globalSettingsGet");
export const saveGlobalSettings = (put: GlobalSettingsPut): Promise<GlobalSettingsRead> =>
  api("globalSettingsPut", undefined, put);
export const loadPiProbe = (): Promise<PiProbe> => api("probePi");
export const checkForUpdate = (): Promise<UpdateCheck> => api("updateCheck");

export const loadPrompt = (persona: Persona): Promise<Prompt> => api("promptGet", { persona });
export const savePrompt = (persona: Persona, put: PromptPut): Promise<Prompt> =>
  api("promptPut", { persona }, put);
export const resetPrompt = (persona: Persona): Promise<Prompt> => api("promptReset", { persona });

export const loadProject = (id: string): Promise<Project> => api("projectGet", { id });
export const loadProjectSessions = (id: string): Promise<SessionView[]> =>
  api("projectSessionList", { id });
export const loadProjectSettings = (id: string): Promise<ProjectSettings> =>
  api("projectSettingsGet", { id });
export const saveProjectSettings = (
  id: string,
  settings: ProjectSettings,
): Promise<ProjectSettings> => api("projectSettingsPut", { id }, settings);
export const deleteProject = (id: string): Promise<Ok> => api("projectDelete", { id });