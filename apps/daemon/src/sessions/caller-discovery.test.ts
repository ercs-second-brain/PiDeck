/**
 * Calling-pane discovery for agent-kind spawns (docs/agent-kinds.md §3):
 * the live `pideck spawn --kind` process is a descendant of the calling
 * pane's shell — walking its ancestry up to a daemon-managed pane PID
 * pinpoints the calling session, whatever role the caller has. Best-effort:
 * anything ambiguous or unresolvable is `undefined` (the spawn route then
 * falls back or rejects — never guesses).
 */

import { describe, expect, it } from "vitest";
import { discoverCallerSession, type ProcessInfo } from "./caller-discovery.js";

function proc(pid: number, ppid: number, cmdline: string[]): ProcessInfo {
  return { pid, ppid, cmdline };
}

/** A pane shell (pi) and the pideck spawn CLI running beneath it. */
function spawnTree(panePid: number, ppidOfPane: number): ProcessInfo[] {
  return [
    proc(1, 0, ["init"]),
    proc(ppidOfPane, 1, ["tmux"]),
    proc(panePid, ppidOfPane, ["sh", "-c", "export PATH=...; exec pi"]),
    proc(panePid + 1, panePid, ["node", ".../pi"]),
    proc(panePid + 2, panePid + 1, ["bash"]),
    proc(panePid + 3, panePid + 2, ["node", "/home/me/.pideck/bin/pideck", "spawn", "--kind", "investigator"]),
  ];
}

describe("discoverCallerSession (docs/agent-kinds.md §3)", () => {
  it("resolves the calling pane from the live spawn process's ancestry", async () => {
    const caller = await discoverCallerSession({
      panePids: async () => new Map([["pideck-proj-worker-1", 500]]),
      processes: async () => spawnTree(500, 2),
    });
    expect(caller).toBe("pideck-proj-worker-1");
  });

  it("resolves regardless of the caller's role (any pane with the spawn in flight)", async () => {
    for (const tmuxSession of [
      "pideck-global-orchestrator-1",
      "pideck-proj-orchestrator-1",
      "pideck-proj-worker-3",
    ]) {
      const caller = await discoverCallerSession({
        panePids: async () => new Map([[tmuxSession, 700]]),
        processes: async () => spawnTree(700, 2),
      });
      expect(caller).toBe(tmuxSession);
    }
  });

  it("returns undefined when the spawn ran outside a daemon pane (no pane ancestor)", async () => {
    const caller = await discoverCallerSession({
      panePids: async () => new Map([["pideck-proj-worker-1", 500]]),
      processes: async () => [
        ...spawnTree(500, 2),
        proc(900, 1, ["node", "/home/me/.pideck/bin/pideck", "spawn", "--kind", "investigator"]), // bare shell
      ],
    });
    // The in-pane spawn still resolves unambiguously; the bare one is ignored.
    expect(caller).toBe("pideck-proj-worker-1");

    const onlyBare = await discoverCallerSession({
      panePids: async () => new Map([["pideck-proj-worker-1", 500]]),
      processes: async () => [proc(900, 1, ["node", "/home/me/.pideck/bin/pideck", "spawn", "--kind", "kiss-audit"])],
    });
    expect(onlyBare).toBeUndefined();
  });

  it("returns undefined when two panes have identical spawns in flight (ambiguous)", async () => {
    const caller = await discoverCallerSession({
      panePids: async () =>
        new Map([
          ["pideck-proj-worker-1", 500],
          ["pideck-proj-worker-2", 600],
        ]),
      processes: async () => [...spawnTree(500, 2), ...spawnTree(600, 2)],
    });
    expect(caller).toBeUndefined();
  });

  it("returns undefined when no spawn is in flight or the process table is unavailable", async () => {
    expect(
      await discoverCallerSession({
        panePids: async () => new Map([["pideck-proj-worker-1", 500]]),
        processes: async () => spawnTree(500, 2).slice(0, 3), // the CLI already exited
      }),
    ).toBeUndefined();
    expect(
      await discoverCallerSession({
        panePids: async () => new Map([["pideck-proj-worker-1", 500]]),
        processes: async () => {
          throw new Error("no /proc on this platform");
        },
      }),
    ).toBeUndefined();
  });

  it("ignores look-alike processes that are not pideck spawns", async () => {
    const caller = await discoverCallerSession({
      panePids: async () => new Map([["pideck-proj-worker-1", 500]]),
      processes: async () => [
        ...spawnTree(500, 2),
        proc(950, 500, ["git", "spawn", "--kind"]), // argv markers, not pideck
      ],
    });
    expect(caller).toBe("pideck-proj-worker-1");
  });
});
