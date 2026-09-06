import type { GhRunner } from "./gh.js";

export interface FakeResponse {
  stdout?: string;
  fail?: boolean;
}

export type RouteHandler = (args: string[]) => FakeResponse | Promise<FakeResponse>;

/** Route values may be a handler function or a plain {@link FakeResponse}. */
export type RouteEntry = RouteHandler | FakeResponse;

function isHandler(entry: RouteEntry): entry is RouteHandler {
  return typeof entry === "function";
}

/**
 * Builds a GhRunner that dispatches on the argv: the route key is the arg at
 * position `matchOn` (e.g. matchOn=1 routes on the API path for `gh api`,
 * matchOn=2 skips `api -i`). Unmatched args fail the call loudly.
 */
export function fakeGhRunner(matchOn: number, routes: Record<string, RouteEntry>): GhRunner {
  return async (args) => {
    const key = args.slice(matchOn, matchOn + 1)[0] ?? "";
    const entry = routes[key];
    if (entry === undefined) {
      throw new Error(`fakeGhRunner: no route for args: ${JSON.stringify(args)}`);
    }
    const response = isHandler(entry) ? await entry(args) : entry;
    if (response.fail === true) {
      const err = new Error(`fake gh failed: ${key}`) as Error & { code?: number; stderr?: string };
      err.code = 1;
      err.stderr = `fake failure for ${key}`;
      throw err;
    }
    return { stdout: response.stdout ?? "", stderr: "" };
  };
}
