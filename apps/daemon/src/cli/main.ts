#!/usr/bin/env node
/**
 * `agentskiss` CLI — the daemon-facing commands the pi orchestration skills
 * invoke (agent/README.md "agentskiss CLI surface"; the exact invocations
 * live in agent/skills/):
 *
 *   agentskiss status [--json]
 *   agentskiss project get <id> [--json] | agentskiss project ls [--json]
 *   agentskiss kanban --project <id> [--json]
 *   agentskiss sessions --project <id> [--json]
 *   agentskiss workers --project <id> [--json]
 *   agentskiss pulls --project <id> [--json]
 *   agentskiss diff --project <id> <pr-number>
 *   agentskiss spawn --project <id> [--issue <number>] --name <label ≤20> [--prompt <task>]
 *   agentskiss send --session <id> --message <text>
 *
 * (Service control — `agentskiss start|stop|...` — is the installer shim in
 * install/bin/agentskiss, which forwards agent commands here.)
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { CliError, optionalFlag, parseArgs, positional, requireFlag } from "./args.js";
import { DaemonClient } from "./client.js";

const USAGE = `agentskiss — talk to the agentsKISS daemon

Usage:
  agentskiss status [--json]
  agentskiss project get <id> [--json]
  agentskiss project ls [--json]
  agentskiss kanban --project <id> [--json]
  agentskiss sessions --project <id> [--json]
  agentskiss workers --project <id> [--json]
  agentskiss pulls --project <id> [--json]
  agentskiss diff --project <id> <pr-number>
  agentskiss spawn --project <id> [--issue <n>] --name <label> [--prompt <task>]
  agentskiss send --session <id> --message <text>

Environment:
  AGENTSKISS_DAEMON_URL   daemon base URL (default http://127.0.0.1:$AGENTSKISS_WEB_PORT or :8321)
`;

export async function run(argv: string[], client: DaemonClient = new DaemonClient()): Promise<number> {
  const parsed = parseArgs(argv);
  const cmd = positional(parsed, 0);
  const sub = positional(parsed, 1);
  // Positionals after the command path ("project get" consumes two).
  const rest = parsed.positionals.slice(cmd === "project" && sub !== undefined ? 2 : 1);
  const json = parsed.flags["json"] === true;
  const out = (value: unknown): void => {
    console.log(JSON.stringify(value, null, 2));
  };

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      if (cmd === undefined && argv.length > 0) throw new CliError(`unknown command: ${argv.join(" ")}\n\n${USAGE}`);
      process.stdout.write(USAGE);
      return 0;
    }

    case "status": {
      const status = await client.status();
      if (json) out(status);
      else
        console.log(
          `agentskiss daemon: up (${status.projects} project(s), ${status.sessions} session(s))`,
        );
      return 0;
    }

    case "project": {
      if (sub === "get") {
        const id = rest[0];
        if (id === undefined) throw new CliError("usage: agentskiss project get <id> [--json]");
        const project = await client.getProject(id);
        if (json) out(project);
        else
          console.log(
            `${project.id}\n  repo:    ${project.repoUrl}\n  branch:  ${project.defaultBranch}\n  name:    ${project.name}\n  auto-agent: ${project.settings.autoAgentUsername ?? "(disabled)"}\n  concurrency: ${project.settings.workerConcurrency}`,
          );
        return 0;
      }
      if (sub === "ls" || sub === "list") {
        const projects = await client.listProjects();
        if (json) out(projects);
        else if (projects.length === 0) console.log("no projects registered");
        else for (const project of projects) console.log(`${project.id}\t${project.repoUrl}`);
        return 0;
      }
      throw new CliError(`usage: agentskiss project get <id> | project ls [--json]`);
    }

    case "kanban": {
      const projectId = requireFlag(parsed.flags, "project", "agentskiss kanban --project <id> [--json]");
      const board = await client.kanban(projectId);
      if (json) out(board);
      else {
        for (const column of board.columns) {
          console.log(`\n## ${column.column} (${column.cards.length})`);
          for (const card of column.cards) {
            console.log(`  #${card.number} [${card.kind}] ${card.title}${card.workerId !== null ? ` (worker: ${card.workerId})` : ""}`);
          }
        }
      }
      return 0;
    }

    case "sessions": {
      const projectId = requireFlag(parsed.flags, "project", "agentskiss sessions --project <id> [--json]");
      const sessions = await client.sessions(projectId);
      if (json) out(sessions);
      else if (sessions.length === 0) console.log("no sessions");
      else
        for (const session of sessions) {
          console.log(`${session.id}\t${session.role}\ttmux:${session.tmuxSession}${session.workerId !== null ? `\tworker:${session.workerId}` : ""}`);
        }
      return 0;
    }

    case "workers": {
      const projectId = requireFlag(parsed.flags, "project", "agentskiss workers --project <id> [--json]");
      const workers = await client.workers(projectId);
      if (json) out(workers);
      else if (workers.length === 0) console.log("no workers");
      else
        for (const worker of workers) {
          console.log(
            `${worker.id}\t${worker.status}\tissue:#${worker.issueNumber}${worker.prNumber !== null ? `\tpr:#${worker.prNumber}` : ""}${worker.statusMessage !== null ? `\t${worker.statusMessage}` : ""}`,
          );
        }
      return 0;
    }

    case "pulls": {
      const projectId = requireFlag(parsed.flags, "project", "agentskiss pulls --project <id> [--json]");
      const pulls = await client.pulls(projectId);
      if (json) out(pulls);
      else if (pulls.length === 0) console.log("no pull requests");
      else
        for (const pr of pulls) {
          console.log(`#${pr.number}\t[${pr.state}]\tci:${pr.ciStatus}\treview:${pr.reviewState}\t${pr.title}\t${pr.url}`);
        }
      return 0;
    }

    case "diff": {
      const projectId = requireFlag(parsed.flags, "project", "agentskiss diff --project <id> <pr-number>");
      const prRaw = rest[0] ?? optionalFlag(parsed.flags, "pr");
      if (prRaw === undefined || !/^\d+$/.test(prRaw)) {
        throw new CliError("usage: agentskiss diff --project <id> <pr-number>");
      }
      const diff = await client.diff(projectId, Number(prRaw));
      if (json) out(diff);
      else {
        console.log(`PR #${diff.prNumber} ${diff.headBranch} → ${diff.baseBranch}`);
        for (const file of diff.files) {
          console.log(`  ${file.status.padEnd(9)} +${file.additions}/-${file.deletions}  ${file.filename}`);
        }
        process.stdout.write(diff.patch);
      }
      return 0;
    }

    case "spawn": {
      const projectId = requireFlag(parsed.flags, "project", "agentskiss spawn --project <id> [--issue <n>] --name <label> [--prompt <task>]");
      const name = requireFlag(parsed.flags, "name", "agentskiss spawn --project <id> [--issue <n>] --name <label> [--prompt <task>]");
      if (name.length > 20) throw new CliError(`--name must be ≤ 20 characters (got ${name.length})`);
      const issueRaw = optionalFlag(parsed.flags, "issue");
      const prompt = optionalFlag(parsed.flags, "prompt");
      if (issueRaw === undefined && prompt === undefined) {
        throw new CliError("spawn needs --issue <number> or --prompt <task>");
      }
      if (issueRaw !== undefined && !/^\d+$/.test(issueRaw)) throw new CliError(`--issue must be a positive number (got ${issueRaw})`);
      const worker = await client.spawn(projectId, {
        ...(issueRaw !== undefined ? { issueNumber: Number(issueRaw) } : {}),
        name,
        ...(prompt !== undefined ? { prompt } : {}),
      });
      if (json) out(worker);
      else
        console.log(
          `worker ${worker.id} spawned (session ${worker.sessionId}, issue #${worker.issueNumber}, status: ${worker.status})`,
        );
      return 0;
    }

    case "send": {
      const sessionId = requireFlag(parsed.flags, "session", "agentskiss send --session <id> --message <text>");
      const message = requireFlag(parsed.flags, "message", "agentskiss send --session <id> --message <text>");
      await client.send(sessionId, message);
      if (json) out({ ok: true, sessionId });
      else console.log(`delivered to ${sessionId}`);
      return 0;
    }

    default:
      throw new CliError(`unknown command: ${String(cmd)}\n\n${USAGE}`);
  }
}

// Entry point when executed directly (`agentskiss ...` via the package bin).
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
      process.stderr.write(`agentskiss: ${message}\n`);
      process.exitCode = exit;
    });
}
