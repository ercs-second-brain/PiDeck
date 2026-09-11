/**
 * The manual spawn route's idle-worker-reuse leg (issue #471) and the
 * issue-prompt resolution it shares with the fresh-spawn leg (issue #378).
 *
 * - {@link issueSpawnPrompt} — the initial prompt an issue-backed spawn
 *   delivers when the caller supplied none (#266 parity): the same builder
 *   the auto-spawn pipeline uses renders the issue context from the
 *   REST-fetched issue; a pull-request number (or any fetch failure) fails
 *   the spawn BEFORE the worker exists — never knowingly spawn an idle
 *   worker.
 * - {@link retaskReusableWorker} — consults the reuse policy for a
 *   lane-carrying spawn and, when an eligible `done` same-lane worker
 *   exists (pane alive, context occupancy at/below the threshold, not
 *   stall-marked/failed), re-tasks it: new issue/prompt on the record,
 *   `running` again, the follow-on prompt delivered through the same
 *   prompt-gate flow as a fresh spawn, and the status change broadcast.
 *   Slot-neutral (the reused worker already occupies its slot), so this is
 *   consulted BEFORE the cap check. Returns the re-tasked worker, or
 *   `null` when the caller must spawn fresh.
 */

import { workerSchema, type Project, type Worker } from "@pideck/shared";

import { deliverSpawnPrompt } from "../agent/prompt-gate.js";
import { resolvePipelineSettings } from "../pipeline/prs/settings.js";
import { buildIssueSpawnPrompt } from "../pipeline/issues/prompts.js";
import { mapRestIssue } from "../github/issues.js";
import { formatRepoRef, parseRepoUrl } from "../github/gh.js";
import { HttpError } from "./router.js";
import type { DaemonServices } from "./context.js";

/**
 * The initial prompt an issue-backed spawn delivers into the fresh pane when
 * the caller supplied none (issue #378, the #266 parity for manual spawns):
 * the orchestrator's canonical invocation (`pideck spawn --project X --issue
 * N --name L`) carries no `--prompt`, so before this resolution the worker
 * booted into pi and sat idle — the exact
 * empty-idle-worker bug #266 fixed for auto-spawns, unfixed on the CLI path.
 * The same builder the auto-spawn pipeline uses renders the issue context
 * from the REST-fetched issue; a number that turns out to be a pull request
 * (or any fetch failure) fails the spawn BEFORE the worker exists — never
 * knowingly spawn an idle worker.
 */
export async function issueSpawnPrompt(services: DaemonServices, project: Project, issueNumber: number): Promise<string> {
  const ref = parseRepoUrl(project.repoUrl);
  let raw: unknown;
  try {
    raw = await services.gh(project.repoUrl).apiJson(`/repos/${formatRepoRef(ref)}/issues/${issueNumber}`);
  } catch (err) {
    throw new HttpError(
      502,
      `cannot fetch issue #${issueNumber} for the worker's initial prompt (repo ${formatRepoRef(ref)}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const record = mapRestIssue(project.id, raw);
  if (record === null) {
    throw new HttpError(400, `#${issueNumber} in ${formatRepoRef(ref)} is not an issue (it may be a pull request); spawn it freeform with --prompt instead`);
  }
  return buildIssueSpawnPrompt(record.issue);
}

/**
 * The issue #471 reuse leg of the manual spawn route: returns the re-tasked
 * worker, or `null` when no worker is reusable and the caller must spawn
 * fresh. The threshold resolves per project, read fresh on every decision.
 */
export async function retaskReusableWorker(
  services: DaemonServices,
  project: Project,
  projectId: string,
  input: { issueNumber?: number; lane: string; prompt?: string },
): Promise<Worker | null> {
  const threshold = resolvePipelineSettings(project, services.settings.get()).workerReuseContextThreshold;
  const reusable = await services.reusePolicy.findReusableWorker({
    projectId,
    lane: input.lane,
    thresholdPct: threshold,
  });
  if (reusable === null) return null;
  const worker = services.sessions.retaskWorker(
    reusable.id,
    input.issueNumber ?? 0,
    input.prompt ?? "",
    "agent running; follow-on task assigned, prompt queued (worker reuse, issue #471)",
  );
  // The one gated delivery dance shared with every other spawn path
  // (issues #56/#318/#378): pi-auth probe → queue on the gate when unready,
  // else the #318 readiness wait + exactly-once type + submit confirmation.
  // Errors propagate: the awaited route fails the spawn request.
  await deliverSpawnPrompt(
    services.sessions,
    services.promptGate,
    () => services.piAuth.payload().then((piAuth) => piAuth.ready),
    { kind: "worker", worker },
    input.prompt,
  );
  const workerParsed = workerSchema.parse(services.sessions.getWorker(worker.id) ?? worker);
  services.hub.broadcast({
    type: "worker.status.changed",
    at: services.now().toISOString(),
    projectId: workerParsed.projectId,
    workerId: workerParsed.id,
    status: workerParsed.status,
  });
  return workerParsed;
}