/**
 * IssueSpawnPipeline retract tests (issue #416): unassign/close must not
 * leave zombie workers — queued spawn tasks are cancelled, blocked records
 * are dropped, and non-terminal workers for the issue are archived (a
 * spawn task already in flight is caught by the post-spawn retract check).
 * Re-assignment after a retract spawns a fresh worker. The spawn-matrix
 * fakes and suites live in pipeline-cap.test.ts / pipeline-spawn.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { WorkerSpawner } from "./ports.js";

import { PROJECT_ID, flush, issueAssigned, makeProject, spawnKeys, type BlockerScript } from "./pipeline-cap.test.js";
import { makeIssue } from "../../testing/fixtures.js";
import { fakeSpawner, makeHarness } from "./pipeline-spawn.test.js";

describe("IssueSpawnPipeline retract (#416: unassign/close leaves no zombies)", () => {
  it("archives a running worker on unassign and respawns on re-assignment", async () => {
    const { pipeline, spawns, archivedKeys } = makeHarness({ blockerScript: new Map([[1, []]]) });
    pipeline.handleEvent(issueAssigned(makeIssue(1)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`]);

    pipeline.handleEvent({ type: "issue.unassigned", at: "2026-09-06T12:00:00Z", issue: makeIssue(1) });
    await flush();
    expect(archivedKeys).toEqual([`${PROJECT_ID}#1`]);
    expect(pipeline.isAccepted(PROJECT_ID, 1)).toBe(false);

    // Re-assign: the retract cleared the dedupe mark, so a fresh worker spawns.
    pipeline.handleEvent(issueAssigned(makeIssue(1)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`, `${PROJECT_ID}#1`]);
  });

  it("archives a running worker when the issue closes", async () => {
    const { pipeline, spawns, archivedKeys } = makeHarness({ blockerScript: new Map([[1, []]]) });
    pipeline.handleEvent(issueAssigned(makeIssue(1)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`]);

    pipeline.handleEvent({ type: "issue.closed", at: "2026-09-06T12:00:00Z", issue: makeIssue(1) });
    await flush();
    expect(archivedKeys).toEqual([`${PROJECT_ID}#1`]);
  });

  it("cancels a cap-queued spawn on unassign — the queued task never runs", async () => {
    const { spawner, spawns } = fakeSpawner({ active: [9] }); // cap slot occupied by another issue
    const { pipeline } = makeHarness({
      blockerScript: new Map([
        [1, []],
        [9, []],
      ]),
      spawner,
      project: makeProject({ workerConcurrency: 1 }),
    });
    pipeline.handleEvent(issueAssigned(makeIssue(1)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([]); // queued behind the cap
    expect(pipeline.isAccepted(PROJECT_ID, 1)).toBe(true);

    pipeline.handleEvent({ type: "issue.unassigned", at: "2026-09-06T12:00:00Z", issue: makeIssue(1) });
    await flush();
    // The retract cancelled the queued task and released the dedupe mark.
    expect(spawnKeys(spawns)).toEqual([]);
    expect(pipeline.isAccepted(PROJECT_ID, 1)).toBe(false);

    // Free the cap slot, then a later assignment spawns cleanly.
    pipeline.handleEvent({ type: "issue.closed", at: "2026-09-06T12:00:00Z", issue: makeIssue(9) });
    await flush();
    pipeline.handleEvent(issueAssigned(makeIssue(1)));
    await flush();
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`]);
  });

  it("drops a blocked-ticket record on unassign so the merge sweep cannot resurrect it", async () => {
    const script: BlockerScript = new Map([[1, [{ number: 2, state: "open", repository: null }]]]);
    const { pipeline, spawns } = makeHarness({ blockerScript: script });
    pipeline.handleEvent(issueAssigned(makeIssue(1)));
    await flush();
    expect(spawns).toHaveLength(0);
    expect(pipeline.isRecordedBlocked(PROJECT_ID, 1)).toBe(true);

    pipeline.handleEvent({ type: "issue.closed", at: "2026-09-06T12:00:00Z", issue: makeIssue(1) });
    await flush();
    expect(pipeline.isRecordedBlocked(PROJECT_ID, 1)).toBe(false);

    // Even unblocked now, the sweep must not spawn the closed issue.
    script.set(1, []);
    await pipeline.sweepUnblocked(PROJECT_ID);
    await flush();
    expect(spawns).toHaveLength(0);
  });

  it("archives a worker whose spawn task was already in flight when the retract landed", async () => {
    // Hold the spawn task mid-flight to reproduce the cancel race.
    let releaseSpawn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (releaseSpawn = resolve));
    const { spawner, spawns, archivedKeys } = fakeSpawner();
    const gated: WorkerSpawner = {
      spawnWorker: async (projectId, issueNumber, prompt) => {
        await gate;
        return spawner.spawnWorker(projectId, issueNumber, prompt);
      },
      listActiveWorkerIssueNumbers: (projectId) => spawner.listActiveWorkerIssueNumbers(projectId),
      archiveWorkersForIssue: (projectId, issueNumber, message) => spawner.archiveWorkersForIssue(projectId, issueNumber, message),
    async retaskWorker(workerId: string): Promise<never> {
      throw new Error(`unexpected retaskWorker(${workerId})`);
    },
    };
    const { pipeline } = makeHarness({ blockerScript: new Map([[1, []]]), spawner: gated });

    pipeline.handleEvent(issueAssigned(makeIssue(1)));
    await flush(); // task started, parked inside spawnWorker
    expect(spawns).toHaveLength(0);

    pipeline.handleEvent({ type: "issue.unassigned", at: "2026-09-06T12:00:00Z", issue: makeIssue(1) });
    await flush();
    expect(archivedKeys).toEqual([]); // nothing registered yet — the retract's archive finds no worker

    releaseSpawn?.();
    await flush();
    // The spawn task's post-spawn retract check archived the just-spawned
    // worker instead of leaving it running.
    expect(spawnKeys(spawns)).toEqual([`${PROJECT_ID}#1`]);
    expect(archivedKeys).toEqual([`${PROJECT_ID}#1`]);
  });
});

