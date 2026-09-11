/**
 * `pideck assign` (issue #491) — extracted from main.ts (the file sits at
 * its max-lines cap): assign an issue to the daemon's gh account, the ONE
 * worker trigger for existing issues. The daemon-side route mutates the
 * GitHub issue only (unassign + re-assign when already assigned, so the
 * re-assignment re-triggers); the watcher's `issue.assigned` transition
 * drives the spawn (assignment-driven spawning, issue #416).
 */

import { CliError, requireFlag, type ParsedArgs } from "./args.js";
import type { DaemonClient } from "./client.js";

/** Everything `cmdAssign` needs from the dispatcher's command context. */
export interface AssignContext {
  parsed: { flags: ParsedArgs["flags"] };
  json: boolean;
  client: DaemonClient;
}

/** `pideck assign --project <id> --issue <n>` — assign (or re-assign to re-trigger). */
export async function cmdAssign(ctx: AssignContext): Promise<number> {
  const usage = "pideck assign --project <id> --issue <n>";
  const projectId = requireFlag(ctx.parsed.flags, "project", usage);
  const issueRaw = requireFlag(ctx.parsed.flags, "issue", usage);
  if (!/^\d+$/.test(issueRaw)) throw new CliError(`--issue must be a positive number (got ${issueRaw})`);
  const result = await ctx.client.assign(projectId, Number(issueRaw));
  emitResult(ctx.json, result);
  return 0;
}

/** `--json` handling shared with every command (issue #134): JSON or human line. */
function emitResult(json: boolean, result: { ok: boolean; issueNumber: number; assignee: string; retriggered: boolean }): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    result.retriggered
      ? `issue #${result.issueNumber} re-assigned to ${result.assignee} (was already assigned — unassigned and re-assigned to re-trigger a worker)`
      : `issue #${result.issueNumber} assigned to ${result.assignee} (auto-triggers a worker)`,
  );
}