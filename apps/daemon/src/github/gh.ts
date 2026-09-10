/**
 * Low-level `gh` CLI wrapper.
 *
 * Every GitHub interaction in this library funnels through a {@link GhRunner}
 * — a function that executes one `gh` invocation and returns stdout/stderr.
 * The default runner spawns the real `gh` binary; tests inject a fake runner,
 * so no unit test ever shells out.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Runner primitives
// ---------------------------------------------------------------------------

export interface GhRunOptions {
  /** Working directory for the gh invocation. */
  cwd?: string;
}

export interface GhRunResult {
  stdout: string;
  stderr: string;
}

/**
 * Executes `gh <args...>`. Implementations must reject on non-zero exit
 * (the default runner rejects with a {@link GhError}).
 */
export type GhRunner = (args: string[], options?: GhRunOptions) => Promise<GhRunResult>;

/** Error raised when a `gh` invocation fails. */
export class GhError extends Error {
  override readonly name = "GhError";
  /** The gh argv that failed (without the `gh` binary itself). */
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], exitCode: number | null, stderr: string, cause?: unknown) {
    const command = ["gh", ...args].join(" ");
    super(`gh command failed (exit ${exitCode ?? "?"}): ${command}\n${stderr.trim()}`, cause === undefined ? undefined : { cause });
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Default {@link GhRunner}: spawns the real `gh` binary. */
export const defaultGhRunner: GhRunner = async (args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string; killSignal?: unknown };
    const exitCode = typeof e.code === "number" ? e.code : null;
    throw new GhError(args, exitCode, e.stderr ?? "", err);
  }
};

// ---------------------------------------------------------------------------
// Repository references
// ---------------------------------------------------------------------------

/** An owner/name pair identifying a GitHub repository. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** `owner/name` shorthand used across the GitHub API. */
export function formatRepoRef(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * Parses a GitHub repository URL (`https://github.com/owner/repo[.git]` or
 * `git@github.com:owner/repo.git`) into an {@link RepoRef}.
 * Throws when the URL does not look like a GitHub repository.
 */
export function parseRepoUrl(url: string): RepoRef {
  const trimmed = url.trim().replace(/\.git$/, "");
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(trimmed);
  if (https) return { owner: https[1] as string, repo: https[2] as string };
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(trimmed);
  if (ssh) return { owner: ssh[1] as string, repo: ssh[2] as string };
  throw new Error(`Not a GitHub repository URL: ${url}`);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

interface GhExecError extends Error {
  code?: number | string;
  stderr?: string;
}

/** Builds a {@link GhError} from an exec-style failure (exported for tests). */
export function ghErrorFromExecError(args: string[], err: unknown): GhError {
  const e = err as GhExecError;
  const exitCode = typeof e.code === "number" ? e.code : null;
  return new GhError(args, exitCode, e.stderr ?? "", err);
}

/** Response of `gh api -i <path>`: parsed body plus lowercase header map. */
export interface GhApiResponse<T> {
  data: T;
  headers: Record<string, string>;
}

/** Thin typed client over the `gh api` / `gh api graphql` subcommands. */
export class GhClient {
  constructor(private readonly run: GhRunner = defaultGhRunner) {}

  /** Runs an arbitrary gh command (exposed for subcommand wrappers). */
  async exec(args: string[], options?: GhRunOptions): Promise<GhRunResult> {
    return this.run(args, options);
  }

  /** GET a REST endpoint and JSON-parse the body. */
  async apiJson<T>(path: string): Promise<T> {
    const { stdout } = await this.run(["api", path]);
    return JSON.parse(stdout) as T;
  }

  /**
   * POSTs to a REST endpoint with `-f` form fields and JSON-parses the
   * response. Array values are repeated fields (`-f "key[]=<v>"` — gh's
   * repeated-field syntax renders them as a JSON array).
   */
  async apiPost<T>(path: string, fields: Record<string, string | string[]>): Promise<T> {
    const args = ["api", "--method", "POST", path];
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        for (const item of value) args.push("-f", `${key}[]=${item}`);
      } else {
        args.push("-f", `${key}=${value}`);
      }
    }
    const { stdout } = await this.run(args);
    return JSON.parse(stdout) as T;
  }

  /** GET a REST endpoint including response headers (via `gh api -i`). */
  async apiWithHeaders<T>(path: string): Promise<GhApiResponse<T>> {
    const { stdout } = await this.run(["api", "-i", path]);
    const match = /\r?\n\r?\n/.exec(stdout);
    if (match === null) {
      throw new GhError(["api", "-i", path], 0, "Could not split gh -i output into headers and body");
    }
    const headerBlock = stdout.slice(0, match.index);
    const body = stdout.slice(match.index + match[0].length);
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split(/\r?\n/).slice(1)) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    return { data: JSON.parse(body) as T, headers };
  }

  /**
   * GET a paginated REST collection. Follows `page` params until a short page
   * is seen or `maxPages` is reached.
   */
  async apiList<T>(path: string, { perPage = 100, maxPages = 10 }: { perPage?: number; maxPages?: number } = {}): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const chunk = await this.apiJson<T[]>(`${path}${sep}per_page=${perPage}&page=${page}`);
      items.push(...chunk);
      if (chunk.length < perPage) break;
    }
    return items;
  }

  /**
   * Runs a GraphQL query. Numeric variables are passed with `-F` (typed),
   * everything else with `-f`. GraphQL-level errors surface as a
   * {@link GhError} (gh exits non-zero and prints the error payload).
   */
  async graphql<T>(query: string, variables: Record<string, string | number> = {}): Promise<T> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === "number") args.push("-F", `${key}=${value}`);
      else args.push("-f", `${key}=${value}`);
    }
    const { stdout } = await this.run(args);
    const payload = JSON.parse(stdout) as { data?: T; errors?: Array<{ message: string }> };
    if (payload.errors !== undefined && payload.errors.length > 0) {
      throw new GhError(args, 0, payload.errors.map((e) => e.message).join("; "));
    }
    if (payload.data === undefined) {
      throw new GhError(args, 0, "GraphQL response contained no data");
    }
    return payload.data;
  }
}
