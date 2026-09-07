/**
 * Contract test for the self-update endpoints (issues #55, #76, #82, #89):
 * `GET /api/update` (with the refresh/cache and active-worker gate) and
 * `POST /api/update/apply`. Runs on its own daemon: the shared one
 * accumulates pipeline auto-spawned workers, which would make the gate
 * counts nondeterministic. The apply spawn is recorded, never executed
 * (the real shim restarts the daemon, which no test can survive).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, updateStatusResponseSchema } from "@agentskiss/shared";

import { LOCAL_SHA, shimBinPath, startContractServer, type ContractServer } from "./contract-fixtures.js";

const updateSpawns: Array<{ file: string; args: readonly string[] }> = [];
let ghCalls = 0;
let upd: ContractServer;

beforeAll(async () => {
  upd = await startContractServer({
    updateRepoUrl: "https://github.com/o/r",
    updateGh: async (args) => {
      ghCalls += 1;
      if (args[0] === "api" && args[1] === "repos/o/r/commits/main") return { stdout: JSON.stringify({ sha: LOCAL_SHA }), stderr: "" };
      throw new Error(`fake gh: unmatched invocation: gh ${args.join(" ")}`);
    },
    updateGit: async (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${LOCAL_SHA}\n`, stderr: "" };
      throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
    },
    updateSpawn: (file, args) => {
      updateSpawns.push({ file, args });
      return { unref() {} };
    },
  });
  mkdirSync(path.join(upd.daemon.stateDir, "bin"), { recursive: true });
  writeFileSync(shimBinPath(upd.daemon), "#!/bin/sh\n");
});

afterAll(async () => {
  await upd?.close();
});

describe("self-update (issues #55, #76)", () => {
  it("exposes the update status (plus the active-worker gate count) through the contract endpoint", async () => {
    const res = await upd.api("GET", endpoints.getUpdateStatus.path);
    expect(res.status).toBe(200);
    // runningSha (issue #89): the build the answering daemon runs — the banner resolves when it equals the target SHA.
    expect(updateStatusResponseSchema.parse(res.json)).toMatchObject({
      repo: "o/r", ref: "main", localSha: LOCAL_SHA, remoteSha: LOCAL_SHA, runningSha: LOCAL_SHA, applyProgress: null,
      updateAvailable: false, error: null, activeWorkers: 0,
    });
  });

  it("serves repeat GETs from the ~5 min cache but refresh=1 forces a re-check (issue #82)", async () => {
    const before = ghCalls;
    await upd.api("GET", endpoints.getUpdateStatus.path); // cached from the previous test
    expect(ghCalls).toBe(before);
    const res = await upd.api("GET", `${endpoints.getUpdateStatus.path}?refresh=1`); // bypasses the cache
    expect(res.status).toBe(200);
    expect(ghCalls).toBe(before + 1);
  });

  it("applies when idle: spawns the installed shim detached and returns immediately", async () => {
    const res = await upd.api("POST", endpoints.applyUpdate.path);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(updateSpawns).toEqual([{ file: shimBinPath(upd.daemon), args: ["update"] }]);
  });

  it("rejects the apply server-side while any worker is active (issue #76)", async () => {
    await upd.api("POST", "/api/projects", { mode: "clone", repoUrl: "https://github.com/sp/gate" });
    const spawned = await upd.api("POST", "/api/projects/sp-gate/spawn", { issueNumber: 1, name: "gater" });
    expect(spawned.status).toBe(201);
    const res = await upd.api("POST", endpoints.applyUpdate.path);
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toMatch(/still active/);
    expect((res.json as { error: string }).error).toMatch(/every agent is idle/);
  });
});
