/**
 * Stand-in for the web shell's typed client (`src/lib/api.ts`): the same
 * call surface, typed against the rest endpoints in `@pideck/shared`, so the
 * onboarding wizard imports one module and the swap to the real client is a
 * single-file change. Responses are parsed with the shared schemas, so a
 * daemon that drifts from the contracts fails loudly here.
 */

import {
  GlobalSettingsReadSchema,
  PiProbeSchema,
  ProbeSchema,
  ProjectSchema,
  StatusSchema,
  restEndpoints,
  type GlobalSettingsPut,
  type GlobalSettingsRead,
  type PiProbe,
  type Probe,
  type Project,
  type ProjectCreate,
  type RestEndpointName,
  type Status,
} from "@pideck/shared";

async function call<T>(
  name: RestEndpointName,
  parse: (data: unknown) => T,
  body?: unknown,
): Promise<T> {
  const endpoint = restEndpoints[name];
  const response = await fetch(endpoint.path, {
    method: endpoint.method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${endpoint.method} ${endpoint.path} failed (${response.status})`);
  }
  return parse(await response.json());
}

export const api = {
  status: (): Promise<Status> => call("status", (data) => StatusSchema.parse(data)),
  probePi: (): Promise<PiProbe> => call("probePi", (data) => PiProbeSchema.parse(data)),
  probeGhPrimary: (): Promise<Probe> => call("probeGhPrimary", (data) => ProbeSchema.parse(data)),
  probeGhReview: (): Promise<Probe> => call("probeGhReview", (data) => ProbeSchema.parse(data)),
  getGlobalSettings: (): Promise<GlobalSettingsRead> =>
    call("globalSettingsGet", (data) => GlobalSettingsReadSchema.parse(data)),
  putGlobalSettings: (body: GlobalSettingsPut): Promise<GlobalSettingsRead> =>
    call("globalSettingsPut", (data) => GlobalSettingsReadSchema.parse(data), body),
  createProject: (body: ProjectCreate): Promise<Project> =>
    call("projectCreate", (data) => ProjectSchema.parse(data), body),
};
