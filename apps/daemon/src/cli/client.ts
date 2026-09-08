/**
 * Typed HTTP client for the pideck CLI.
 *
 * Contract-backed calls go through the shared endpoint map (`formatPath` +
 * response-schema validation), so a daemon that returns a payload violating
 * the shared contract fails the CLI loudly — the same contract-mismatch
 * guarantee the server side gets.
 */

import { z } from "zod";
import {
  endpoints,
  formatPath,
  kanbanBoardSchema,
  projectSchema,
  pullRequestDiffSchema,
  pullRequestSchema,
  sessionSchema,
  settingsSchema,
  workerSchema,
  type KanbanBoard,
  type Project,
  type PullRequest,
  type PullRequestDiff,
  type Session,
  type Settings,
  type Worker,
} from "@pideck/shared";

import { CliError } from "./args.js";

/** Daemon base URL: `PD_DAEMON_URL`, else host/port env, else loopback:8321. */
export function daemonBaseUrl(): string {
  const url = process.env["PD_DAEMON_URL"];
  if (url !== undefined && url.length > 0) return url.replace(/\/$/, "");
  const host = process.env["PD_WEB_HOST"];
  const port = process.env["PD_WEB_PORT"] ?? "8321";
  return `http://${host !== undefined && host.length > 0 ? host : "127.0.0.1"}:${port}`;
}

export class DaemonClient {
  constructor(private readonly baseUrl: string = daemonBaseUrl()) {}

  private async request<T>(method: string, path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new CliError(
        `cannot reach the pideck daemon at ${this.baseUrl} (${err instanceof Error ? err.message : String(err)}). Is it running? Try 'pideck status --json' or start it with the installer's service control.`,
        3,
      );
    }
    const text = await res.text();
    let payload: unknown;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    }
    if (!res.ok) {
      const message = typeof payload === "object" && payload !== null && "error" in payload ? String((payload as { error: unknown }).error) : text;
      throw new CliError(`daemon error (HTTP ${res.status}): ${message}`, 1);
    }
    return schema === undefined ? (payload as T) : schema.parse(payload);
  }

  // -- CLI-specific daemon actions (agent/README.md, finalized in #9) -------

  /** `pideck status --json` — daemon liveness (+ pi auth fields, issue #57; node runtime fields, issue #202; installed pi version, issue #223). */
  async status(): Promise<{
    ok: boolean;
    name: string;
    projects: number;
    sessions: number;
    piReady?: boolean;
    piProviders?: string[];
    piVersion?: string | null;
    nodeVersion?: string;
    nodeTooOld?: boolean;
    at: string;
  }> {
    return this.request("GET", "/api/status");
  }

  /** `pideck spawn` — daemon spawns the worker (tmux + registry + event). */
  async spawn(projectId: string, input: { issueNumber?: number; name: string; prompt?: string }): Promise<Worker> {
    const body: Record<string, unknown> = { name: input.name };
    if (input.issueNumber !== undefined) body["issueNumber"] = input.issueNumber;
    if (input.prompt !== undefined) body["prompt"] = input.prompt;
    return this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/spawn`, body, workerSchema);
  }

  /** `pideck send` — deliver a message into a session's tmux pane. */
  async send(sessionId: string, message: string): Promise<void> {
    await this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/send`, { message });
  }

  /**
   * `pideck report-pr` — a worker session reports the PR it opened
   * (issue #49). The daemon resolves the worker from the tmux session name
   * the CLI self-identified from its own pane context.
   */
  async reportPr(tmuxSession: string, prNumber: number): Promise<Worker> {
    return this.request("POST", "/api/sessions/report-pr", { tmuxSession, prNumber }, workerSchema);
  }

  // -- Contract endpoints (validated against the shared schemas) -------------

  async listProjects(): Promise<Project[]> {
    return this.request("GET", formatPath("listProjects", {}), undefined, z.array(projectSchema));
  }

  async getProject(projectId: string): Promise<Project> {
    return this.request("GET", formatPath("getProject", { projectId }), undefined, projectSchema);
  }

  async kanban(projectId: string): Promise<KanbanBoard> {
    return this.request("GET", formatPath("getProjectKanban", { projectId }), undefined, kanbanBoardSchema);
  }

  async sessions(projectId?: string): Promise<Session[]> {
    return projectId !== undefined
      ? this.request("GET", formatPath("listProjectSessions", { projectId }), undefined, z.array(sessionSchema))
      : this.request("GET", endpoints.listAllSessions.path, undefined, z.array(sessionSchema));
  }

  async workers(projectId: string): Promise<Worker[]> {
    return this.request("GET", formatPath("listProjectWorkers", { projectId }), undefined, z.array(workerSchema));
  }

  async pulls(projectId: string): Promise<PullRequest[]> {
    return this.request("GET", formatPath("listProjectPullRequests", { projectId }), undefined, z.array(pullRequestSchema));
  }

  async diff(projectId: string, prNumber: number): Promise<PullRequestDiff> {
    return this.request("GET", formatPath("getPullRequestDiff", { projectId, prNumber }), undefined, pullRequestDiffSchema);
  }

  async settings(): Promise<Settings> {
    return this.request("GET", endpoints.getSettings.path, undefined, settingsSchema);
  }
}
