#!/usr/bin/env node
/**
 * `pideck` CLI — the daemon-facing commands the pi orchestration skills
 * invoke (agent/README.md "pideck CLI surface"; the exact invocations
 * live in agent/skills/):
 *
 *   pideck status [--json]
 *   pideck project get <id> [--json] | pideck project ls [--json]
 *   pideck kanban --project <id> [--json]
 *   pideck sessions [--project <id>] [--json]
 *   pideck workers --project <id> [--json]
 *   pideck pulls --project <id> [--json]
 *   pideck diff --project <id> <pr-number>
 *   pideck spawn --project <id> [--issue <number>] --name <label ≤20> [--prompt <task>]
 *   pideck send --session <id> --message <text>
 *   pideck report-pr <pr-number>   (worker panes only: self-identifies via tmux)
 *
 * (Service control — `pideck start|stop|...` — is the installer shim in
 * install/bin/pideck, which forwards agent commands here.)
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { CliError, optionalFlag, parseArgs, positional, requireFlag, type ParsedArgs } from "./args.js";
import { DaemonClient } from "./client.js";
import { currentTmuxSession } from "./tmux-context.js";

/** Injectables for tests (defaults: the live tmux context). */
export interface RunDeps {
  /** Resolves the calling tmux session's name (issue #49 report path). */
  tmuxSession?: () => Promise<string>;
}

const USAGE = `pideck — talk to the PiDeck daemon

Usage:
  pideck status [--json]
  pideck project get <id> [--json]
  pideck project ls [--json]
  pideck kanban --project <id> [--json]
  pideck sessions [--project <id>] [--json]
  pideck workers --project <id> [--json]
  pideck pulls --project <id> [--json]
  pideck diff --project <id> <pr-number>
  pideck spawn --project <id> [--issue <n>] --name <label> [--prompt <task>]
  pideck send --session <id> --message <text>
  pideck report-pr <pr-number>

Environment:
  PD_DAEMON_URL   daemon base URL (default http://127.0.0.1:$PD_WEB_PORT or :8321)
`;

/** Everything a command handler needs; assembled once by {@link run}. */
interface CommandContext {
  /** The raw argv (for unknown-command error messages). */
  argv: string[];
  parsed: ParsedArgs;
  /** Positionals after the command path ("project get" consumes two). */
  rest: string[];
  /** Whether `--json` was passed (JSON output instead of human rendering). */
  json: boolean;
  client: DaemonClient;
  deps: RunDeps;
}

type Command = (ctx: CommandContext) => Promise<number>;

/**
 * `--json` handling shared by every command (issue #134): print the value
 * as pretty-printed JSON, or run the command's human rendering.
 */
function emit(json: boolean, value: unknown, pretty: () => void): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else pretty();
}

async function cmdStatus(ctx: CommandContext): Promise<number> {
  const status = await ctx.client.status();
  emit(ctx.json, status, () => {
    console.log(
      `pideck daemon: up (${status.projects} project(s), ${status.sessions} session(s))`,
    );
    // Surface pi auth honestly (issue #57): an unauthenticated daemon
    // must never read as fully healthy.
    if (status.piReady === false) {
      console.warn(
        "warning: pi auth not ready — run 'pideck onboard' (or pi /login); worker prompts are queued until a provider is ready",
      );
    }
    // Surface the node/pi pairing (issue #202): a daemon on an old node
    // spawns pi sessions that crash on first request.
    if (status.nodeTooOld === true) {
      console.warn(
        `warning: daemon runs node ${status.nodeVersion}, too old for pi (needs >= 22.19.0) — run 'pideck update' to refresh the runtime and reinstall pi together`,
      );
    }
  });
  return 0;
}

async function cmdProject(ctx: CommandContext): Promise<number> {
  const sub = positional(ctx.parsed, 1);
  if (sub === "get") {
    const id = ctx.rest[0];
    if (id === undefined) throw new CliError("usage: pideck project get <id> [--json]");
    const project = await ctx.client.getProject(id);
    emit(ctx.json, project, () =>
      console.log(
        `${project.id}\n  repo:    ${project.repoUrl}\n  branch:  ${project.defaultBranch}\n  name:    ${project.name}\n  auto-agent: ${project.settings.autoAgentUsername ?? "(disabled)"}\n  concurrency: ${project.settings.workerConcurrency ?? "unbounded"}`,
      ),
    );
    return 0;
  }
  if (sub === "ls" || sub === "list") {
    const projects = await ctx.client.listProjects();
    emit(ctx.json, projects, () => {
      if (projects.length === 0) console.log("no projects registered");
      else for (const project of projects) console.log(`${project.id}\t${project.repoUrl}`);
    });
    return 0;
  }
  throw new CliError(`usage: pideck project get <id> | project ls [--json]`);
}

async function cmdKanban(ctx: CommandContext): Promise<number> {
  const projectId = requireFlag(
    ctx.parsed.flags,
    "project",
    "pideck kanban --project <id> [--json]",
  );
  const board = await ctx.client.kanban(projectId);
  emit(ctx.json, board, () => {
    for (const column of board.columns) {
      console.log(`\n## ${column.column} (${column.cards.length})`);
      for (const card of column.cards) {
        console.log(`  #${card.number} [${card.kind}] ${card.title}${card.workerId !== null ? ` (worker: ${card.workerId})` : ""}`);
      }
    }
  });
  return 0;
}

async function cmdSessions(ctx: CommandContext): Promise<number> {
  // `--project` is optional: with it, one project's sessions; without it,
  // every session daemon-wide (including the global agent's) — how the
  // global agent discovers each project's orchestrator session id.
  const projectId = optionalFlag(ctx.parsed.flags, "project");
  const sessions = await ctx.client.sessions(projectId);
  emit(ctx.json, sessions, () => {
    if (sessions.length === 0) console.log("no sessions");
    else
      for (const session of sessions) {
        console.log(
          `${session.id}\t${session.projectId}\t${session.role}\ttmux:${session.tmuxSession}${session.workerId !== null ? `\tworker:${session.workerId}` : ""}`,
        );
      }
  });
  return 0;
}

async function cmdWorkers(ctx: CommandContext): Promise<number> {
  const projectId = requireFlag(
    ctx.parsed.flags,
    "project",
    "pideck workers --project <id> [--json]",
  );
  const workers = await ctx.client.workers(projectId);
  emit(ctx.json, workers, () => {
    if (workers.length === 0) console.log("no workers");
    else
      for (const worker of workers) {
        console.log(
          `${worker.id}\t${worker.status}\tissue:#${worker.issueNumber}${worker.prNumber !== null ? `\tpr:#${worker.prNumber}` : ""}${worker.statusMessage !== null ? `\t${worker.statusMessage}` : ""}`,
        );
      }
  });
  return 0;
}

async function cmdPulls(ctx: CommandContext): Promise<number> {
  const projectId = requireFlag(ctx.parsed.flags, "project", "pideck pulls --project <id> [--json]");
  const pulls = await ctx.client.pulls(projectId);
  emit(ctx.json, pulls, () => {
    if (pulls.length === 0) console.log("no pull requests");
    else
      for (const pr of pulls) {
        console.log(`#${pr.number}\t[${pr.state}]\tci:${pr.ciStatus}\treview:${pr.reviewState}\t${pr.title}\t${pr.url}`);
      }
  });
  return 0;
}

async function cmdDiff(ctx: CommandContext): Promise<number> {
  const projectId = requireFlag(ctx.parsed.flags, "project", "pideck diff --project <id> <pr-number>");
  const prRaw = ctx.rest[0] ?? optionalFlag(ctx.parsed.flags, "pr");
  if (prRaw === undefined || !/^\d+$/.test(prRaw)) {
    throw new CliError("usage: pideck diff --project <id> <pr-number>");
  }
  const diff = await ctx.client.diff(projectId, Number(prRaw));
  emit(ctx.json, diff, () => {
    console.log(`PR #${diff.prNumber} ${diff.headBranch} → ${diff.baseBranch}`);
    for (const file of diff.files) {
      console.log(`  ${file.status.padEnd(9)} +${file.additions}/-${file.deletions}  ${file.filename}`);
    }
    process.stdout.write(diff.patch);
  });
  return 0;
}

async function cmdSpawn(ctx: CommandContext): Promise<number> {
  const usage = "pideck spawn --project <id> [--issue <n>] --name <label> [--prompt <task>]";
  const projectId = requireFlag(ctx.parsed.flags, "project", usage);
  const name = requireFlag(ctx.parsed.flags, "name", usage);
  if (name.length > 20) throw new CliError(`--name must be ≤ 20 characters (got ${name.length})`);
  const issueRaw = optionalFlag(ctx.parsed.flags, "issue");
  const prompt = optionalFlag(ctx.parsed.flags, "prompt");
  if (issueRaw === undefined && prompt === undefined) {
    throw new CliError("spawn needs --issue <number> or --prompt <task>");
  }
  if (issueRaw !== undefined && !/^\d+$/.test(issueRaw)) throw new CliError(`--issue must be a positive number (got ${issueRaw})`);
  const worker = await ctx.client.spawn(projectId, {
    ...(issueRaw !== undefined ? { issueNumber: Number(issueRaw) } : {}),
    name,
    ...(prompt !== undefined ? { prompt } : {}),
  });
  emit(ctx.json, worker, () =>
    console.log(
      `worker ${worker.id} spawned (session ${worker.sessionId}, issue #${worker.issueNumber}, status: ${worker.status})`,
    ),
  );
  return 0;
}

async function cmdSend(ctx: CommandContext): Promise<number> {
  const sessionId = requireFlag(ctx.parsed.flags, "session", "pideck send --session <id> --message <text>");
  const message = requireFlag(ctx.parsed.flags, "message", "pideck send --session <id> --message <text>");
  await ctx.client.send(sessionId, message);
  emit(ctx.json, { ok: true, sessionId }, () => console.log(`delivered to ${sessionId}`));
  return 0;
}

async function cmdReportPr(ctx: CommandContext): Promise<number> {
  // Worker self-report of an opened PR (issue #49). The tmux session
  // name is resolved from the calling pane's own context, not from a
  // flag — the daemon associates the worker behind that session.
  const prRaw = ctx.rest[0] ?? optionalFlag(ctx.parsed.flags, "pr");
  if (prRaw === undefined || !/^\d+$/.test(prRaw)) {
    throw new CliError("usage: pideck report-pr <pr-number>");
  }
  const tmuxSession = await (ctx.deps.tmuxSession ?? currentTmuxSession)();
  const worker = await ctx.client.reportPr(tmuxSession, Number(prRaw));
  emit(ctx.json, worker, () => console.log(`worker ${worker.id} now owns PR #${worker.prNumber}`));
  return 0;
}

/** Command table (issue #134): run() dispatches, each handler stays small. */
const commands: Record<string, Command> = {
  status: cmdStatus,
  project: cmdProject,
  kanban: cmdKanban,
  sessions: cmdSessions,
  workers: cmdWorkers,
  pulls: cmdPulls,
  diff: cmdDiff,
  spawn: cmdSpawn,
  send: cmdSend,
  "report-pr": cmdReportPr,
};

/** Prints the usage text (`pideck`, `pideck help|--help|-h`). */
async function cmdHelp(): Promise<number> {
  process.stdout.write(USAGE);
  return 0;
}

export async function run(
  argv: string[],
  client: DaemonClient = new DaemonClient(),
  deps: RunDeps = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  const cmd = positional(parsed, 0);
  const sub = positional(parsed, 1);
  // Positionals after the command path ("project get" consumes two).
  const rest = parsed.positionals.slice(cmd === "project" && sub !== undefined ? 2 : 1);
  const handler =
    cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h"
      ? cmdHelp
      : commands[cmd];
  if (handler === undefined) {
    throw new CliError(`unknown command: ${String(cmd)}\n\n${USAGE}`);
  }
  if (cmd === undefined && argv.length > 0) {
    // Flags without a command are never valid (issue #134: parity with the
    // old switch — `pideck --json` errors, bare `pideck` shows help).
    throw new CliError(`unknown command: ${argv.join(" ")}\n\n${USAGE}`);
  }
  return handler({ argv, parsed, rest, json: parsed.flags["json"] === true, client, deps });
}

// Entry point when executed directly (`pideck ...` via the package bin).
/* v8 ignore next */
const invokedAs = process.argv[1] !== undefined ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedAs !== undefined && import.meta.url === invokedAs) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const exit = err instanceof CliError ? err.exitCode : 1;
      process.stderr.write(`pideck: ${message}\n`);
      process.exitCode = exit;
    });
}
