/**
 * The daemon half of the `pideck` CLI. The installed shim handles service
 * verbs and forwards everything else here; this module talks to the daemon's
 * REST API over `PD_DAEMON_URL` (default loopback `PD_WEB_PORT`).
 */

import { pathToFileURL } from "node:url";
import type { Project, SessionTrace, SessionView, Status, TraceEntry, TraceFacts } from "@pideck/shared";

export interface CliIo {
  url: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const USAGE = `usage:
  pideck status [--json]
  pideck project ls [--json]
  pideck project get <id> [--json]
  pideck sessions [--project <id>] [--json]
  pideck workers --project <id> [--json]
  pideck send --session <id> --message <text>
  pideck trace <session-id> [--follow]`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (err) {
    io.stderr(`pideck: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function dispatch(argv: string[], io: CliIo): Promise<number> {
  const asJson = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const [cmd, ...rest] = args;

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.stderr(USAGE);
      return cmd === undefined ? 2 : 0;

    case "status": {
      const status = await request<Status>(io, "GET", "/api/status");
      output(io, asJson, status, (s) => [
        `version: ${s.version}`,
        `state dir: ${s.stateDir}`,
        `poll: every ${s.pollIntervalSeconds}s`,
        `pi: ${s.piReady ? "ready" : "not ready"}`,
        `gh: ${s.ghReady ? "ready" : "not ready"}`,
        ...(s.github.throttledUntil !== null
          ? [`github: throttled until ${clock(s.github.throttledUntil)}`]
          : []),
        ...(s.github.lastError !== null ? [`github: last error: ${s.github.lastError}`] : []),
        ...(s.github.throttledUntil === null && s.github.lastError === null ? ["github: ok"] : []),
      ]);
      return 0;
    }

    case "project": {
      const [sub, id] = rest;
      if (sub === "ls") {
        const projects = await request<Project[]>(io, "GET", "/api/projects");
        output(io, asJson, projects, (list) =>
          list.map((p) => `${p.id}  ${p.name}  ${p.owner}/${p.repo}  ${p.path}`),
        );
        return 0;
      }
      if (sub === "get") {
        if (!id) return usageError(io, "project get needs an id");
        const project = await request<Project>(io, "GET", `/api/projects/${enc(id)}`);
        output(io, asJson, project, (p) => [
          `id: ${p.id}`,
          `name: ${p.name}`,
          `repo: ${p.repoUrl}`,
          `default branch: ${p.defaultBranch}`,
          `path: ${p.path}`,
        ]);
        return 0;
      }
      return usageError(io, `unknown project command: ${sub ?? ""}`);
    }

    case "sessions": {
      const project = flag(args, "--project");
      const path = project
        ? `/api/projects/${enc(project)}/sessions`
        : "/api/sessions";
      const sessions = await request<SessionView[]>(io, "GET", path);
      output(io, asJson, sessions, (views) => views.map(sessionLine));
      return 0;
    }

    case "workers": {
      const project = flag(args, "--project");
      if (!project) return usageError(io, "workers needs --project <id>");
      const sessions = await request<SessionView[]>(io, "GET", `/api/projects/${enc(project)}/sessions`);
      const workers = sessions.filter((view) => view.session.persona === "worker");
      output(io, asJson, workers, (views) => views.map(sessionLine));
      return 0;
    }

    case "send": {
      const session = flag(args, "--session");
      const message = flag(args, "--message");
      if (!session || !message) return usageError(io, "send needs --session <id> --message <text>");
      await request(io, "POST", `/api/sessions/${enc(session)}/send`, { text: message });
      output(io, asJson, { ok: true }, () => [`sent to ${session}`]);
      return 0;
    }

    case "trace": {
      const id = rest[0];
      if (!id) return usageError(io, "trace needs a session id");
      const trace = await request<SessionTrace>(io, "GET", `/api/sessions/${enc(id)}/trace`);
      if (asJson) {
        io.stdout(JSON.stringify(trace, null, 2));
        return 0;
      }
      for (const line of trace.entries.map(traceLine)) io.stdout(line);
      if (flag(args, "--follow")) await followTrace(io, id, trace.entries.length);
      return 0;
    }

    default:
      return usageError(io, `unknown command: ${String(cmd)}`);
  }
}

export function daemonUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.PD_DAEMON_URL ?? `http://127.0.0.1:${env.PD_WEB_PORT ?? 8321}`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const io: CliIo = {
    url: daemonUrl(),
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
  try {
    return await runCli(argv, io);
  } catch (err) {
    io.stderr(`pideck: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}

async function request<T>(
  io: CliIo,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${io.url}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text };
  }
  if (!res.ok) {
    const detail =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText;
    throw new Error(`${method} ${path} failed: ${res.status} ${detail}`);
  }
  return parsed as T;
}

function output<T>(io: CliIo, asJson: boolean, data: T, human: (data: T) => string[]): void {
  if (asJson) {
    io.stdout(JSON.stringify(data, null, 2));
    return;
  }
  for (const line of human(data)) io.stdout(line);
}

function sessionLine(view: SessionView): string {
  const s = view.session;
  return [
    s.id,
    s.persona,
    s.projectId ?? "-",
    s.issueNumber === undefined ? "-" : `#${s.issueNumber}`,
    s.prNumber === undefined ? "-" : `!${s.prNumber}`,
    s.archivedAt === undefined ? "active" : "archived",
  ].join("  ");
}

function traceLine(entry: TraceEntry): string {
  const head = `${entry.at}  ${entry.kind}`;
  if (entry.kind === "delivery") return `${head}  ${entry.text ?? ""}`;
  if (entry.kind === "state") {
    return `${head}  ${entry.from ?? "-"} → ${entry.to ?? "-"} · ${entry.status ?? ""}`;
  }
  if (entry.kind === "facts") return `${head}  ${factsLine(entry.facts)}`;
  return `${head}  ${entry.detail ?? ""}`;
}

function factsLine(facts: TraceFacts | undefined): string {
  if (facts === undefined) return "";
  const parts: string[] = [];
  if (facts.issueNumber !== undefined) parts.push(`issue #${facts.issueNumber}`);
  if (facts.openBlockers !== undefined) parts.push(`blockers ${facts.openBlockers}`);
  if (facts.prNumber !== undefined) parts.push(`PR #${facts.prNumber}`);
  if (facts.headSha !== undefined) parts.push(`head ${facts.headSha.slice(0, 7)}`);
  if (facts.ci !== undefined) parts.push(`ci ${facts.ci}`);
  if (facts.failingChecks !== undefined && facts.failingChecks.length > 0) {
    parts.push(`failing: ${facts.failingChecks.join(", ")}`);
  }
  if (facts.reviewDecision !== undefined) parts.push(`review ${facts.reviewDecision ?? "-"}`);
  if (facts.mergeable !== undefined) parts.push(facts.mergeable.toLowerCase());
  return parts.join(" · ");
}

/** Follows a session's trace: re-fetches every second, printing new entries. */
async function followTrace(io: CliIo, id: string, seen: number): Promise<never> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const trace = await request<SessionTrace>(io, "GET", `/api/sessions/${enc(id)}/trace`);
      for (const entry of trace.entries.slice(seen)) io.stdout(traceLine(entry));
      seen = Math.max(seen, trace.entries.length);
    } catch {
      // Daemon restarting or reloading — keep polling.
    }
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Local wall-clock hh:mm for an ISO timestamp. */
function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function usageError(io: CliIo, message: string): number {
  io.stderr(`pideck: ${message}\n${USAGE}`);
  return 2;
}