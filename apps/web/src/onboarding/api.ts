/**
 * Stand-in for the web shell's typed client (`src/lib/api.ts`): the same
 * `api(name, params?, body?)` surface, typed against the rest endpoints in
 * `@pideck/shared`, so the onboarding wizard imports one module and the swap
 * to the real client is a single import change. Responses are parsed with the
 * shared schemas, so a daemon that drifts from the contracts fails loudly
 * here.
 */

import { restEndpoints, type RestEndpointName } from "@pideck/shared";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type EndpointOf<Name extends RestEndpointName> = (typeof restEndpoints)[Name];
type Parsed<T> = T extends { parse: (data: never) => infer Out } ? Out : never;
type Response<Name extends RestEndpointName> = Parsed<EndpointOf<Name>["response"]>;

export async function api<Name extends RestEndpointName>(
  name: Name,
  params?: Record<string, string>,
  body?: unknown,
): Promise<Response<Name>> {
  const endpoint = restEndpoints[name];
  const path = Object.entries(params ?? {}).reduce(
    (acc, [key, value]) => acc.replace(`:${key}`, encodeURIComponent(value)),
    endpoint.path,
  );
  const response = await fetch(path, {
    method: endpoint.method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, `${endpoint.method} ${path} failed (${response.status})`);
  }
  const data = (endpoint.response as { parse: (data: unknown) => unknown }).parse(await response.json());
  return data as Response<Name>;
}
