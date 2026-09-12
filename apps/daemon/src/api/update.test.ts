import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionRegistry } from "../sessions/registry.js";
import { sessionRecord, tempStateDir } from "./testing.js";
import { createUpdater, type UpdateRunner } from "./update.js";
import { ApiError } from "./router.js";

const LOCAL_SHA = "a".repeat(40);
const REMOTE_SHA = "b".repeat(40);
/** Two hours before the harness clock's epoch, so the ref reads "2 h old". */
const REMOTE_DATE = new Date(-2 * 60 * 60 * 1000).toISOString();

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface Harness {
  updater: ReturnType<typeof createUpdater>;
  calls: string[][];
  spawns: string[][];
  setClock: (ms: number) => void;
  setRunningSha: (sha: string) => void;
  setLocalSha: (sha: string) => void;
  setRemoteSha: (sha: string) => void;
  setRemoteDate: (iso: string) => void;
  /** The updater call with the harness's running build SHA. */
  check: (force?: boolean) => ReturnType<ReturnType<typeof createUpdater>["check"]>;
  apply: () => ReturnType<ReturnType<typeof createUpdater>["apply"]>;
}

function makeHarness(options: { configJson?: string } = {}): Harness {
  const stateDir = tempStateDir();
  dirs.push(stateDir);
  const calls: string[][] = [];
  const spawns: string[][] = [];
  let runningSha = LOCAL_SHA;
  let localSha = LOCAL_SHA;
  let remoteSha = REMOTE_SHA;
  let remoteDate = REMOTE_DATE;
  let clock = 0;
  const run: UpdateRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "rev-parse") return { stdout: `${localSha}\n` };
    if (cmd === "git" && args[0] === "remote") {
      return { stdout: "https://github.com/acme/widget.git\n" };
    }
    if (cmd === "gh") return { stdout: `${remoteSha} ${remoteDate}\n` };
    return { stdout: "" };
  };
  const updater = createUpdater({
    srcDir: stateDir,
    configJson: options.configJson,
    registry: new SessionRegistry(stateDir),
    run,
    spawn: (cmd, args) => {
      spawns.push([cmd, ...args]);
    },
    now: () => clock,
  });
  return {
    updater,
    calls,
    spawns,
    setClock: (ms) => {
      clock = ms;
    },
    setRunningSha: (sha) => {
      runningSha = sha;
    },
    setLocalSha: (sha) => {
      localSha = sha;
    },
    setRemoteSha: (sha) => {
      remoteSha = sha;
    },
    setRemoteDate: (iso) => {
      remoteDate = iso;
    },
    check: (force) => updater.check(runningSha, force),
    apply: () => updater.apply(runningSha),
  };
}

describe("update check", () => {
  it("reports an update when the checkout is behind the upstream ref", () => {
    const h = makeHarness();
    expect(h.check()).toEqual({ state: "updateAvailable", latestVersion: "bbbbbbb · 2 h old" });
    expect(h.calls).toContainEqual([
      "gh",
      "api",
      "repos/acme/widget/commits/main",
      "--jq",
      '.sha + " " + (.commit.committer.date // "")',
    ]);
  });

  it("reports up to date when the running daemon already runs the upstream ref", () => {
    const h = makeHarness();
    h.setRunningSha(REMOTE_SHA);
    expect(h.check()).toEqual({ state: "upToDate", latestVersion: "bbbbbbb · 2 h old" });
  });

  it("reports restart needed when the checkout is current but the daemon is older", () => {
    const h = makeHarness();
    h.setLocalSha(REMOTE_SHA);
    expect(h.check()).toEqual({ state: "restartNeeded", latestVersion: "bbbbbbb · 2 h old" });
  });

  it("falls back to the bare short SHA when the ref date is unusable", () => {
    const h = makeHarness();
    h.setRemoteDate("");
    expect(h.check()).toEqual({ state: "updateAvailable", latestVersion: "bbbbbbb" });
  });

  it("takes repoUrl and repoRef from the install's config.json when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "pideck-update-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ repoUrl: "git@github.com:acme/fork.git", repoRef: "release" }),
    );
    const h = makeHarness({ configJson: join(dir, "config.json") });
    h.check();
    expect(h.calls).toContainEqual([
      "gh",
      "api",
      "repos/acme/fork/commits/release",
      "--jq",
      '.sha + " " + (.commit.committer.date // "")',
    ]);
    expect(h.calls).not.toContainEqual(["git", "remote", "get-url", "origin"]);
  });

  it("caches a successful check for about an hour", () => {
    const h = makeHarness();
    h.check();
    const afterFirst = h.calls.length;

    h.setClock(30 * 60 * 1000);
    h.check();
    expect(h.calls).toHaveLength(afterFirst);

    h.setClock(61 * 60 * 1000);
    h.check();
    expect(h.calls.length).toBeGreaterThan(afterFirst);
  });

  it("does not serve a stale check after the upstream moved", () => {
    const h = makeHarness();
    expect(h.check()).toEqual({ state: "updateAvailable", latestVersion: "bbbbbbb · 2 h old" });
    h.setLocalSha(REMOTE_SHA);
    h.setClock(61 * 60 * 1000);
    expect(h.check()).toEqual({ state: "restartNeeded", latestVersion: "bbbbbbb · 3 h old" });
  });

  it("an explicit check bypasses the cache and refreshes it", () => {
    const h = makeHarness();
    h.check();
    const afterFirst = h.calls.length;

    h.setRemoteSha("c".repeat(40));
    expect(h.check(true)).toEqual({ state: "updateAvailable", latestVersion: "ccccccc · 2 h old" });
    expect(h.calls.length).toBeGreaterThan(afterFirst);

    // The refreshed result is served to passive callers within the TTL.
    const afterFresh = h.calls.length;
    expect(h.check()).toEqual({ state: "updateAvailable", latestVersion: "ccccccc · 2 h old" });
    expect(h.calls).toHaveLength(afterFresh);
  });
});

describe("update apply gate", () => {
  /** Builds an updater whose check works: checkout at LOCAL_SHA, upstream
   *  at REMOTE_SHA, overridable before each apply. */
  function gateHarness(): {
    updater: ReturnType<typeof createUpdater>;
    registry: SessionRegistry;
    spawns: string[][];
    setLocalSha: (sha: string) => void;
  } {
    const stateDir = tempStateDir();
    dirs.push(stateDir);
    const registry = new SessionRegistry(stateDir);
    const spawns: string[][] = [];
    let localSha = LOCAL_SHA;
    const updater = createUpdater({
      srcDir: stateDir,
      registry,
      run: (cmd, args) => {
        if (cmd === "git" && args[0] === "rev-parse") return { stdout: `${localSha}\n` };
        if (cmd === "git" && args[0] === "remote") {
          return { stdout: "https://github.com/acme/widget.git\n" };
        }
        if (cmd === "gh") return { stdout: `${REMOTE_SHA} ${REMOTE_DATE}\n` };
        return { stdout: "" };
      },
      spawn: (cmd, args) => {
        spawns.push([cmd, ...args]);
      },
    });
    return {
      updater,
      registry,
      spawns,
      setLocalSha: (sha) => {
        localSha = sha;
      },
    };
  }

  it("refuses while a worker or reviewer session is live", () => {
    const { updater, registry, spawns } = gateHarness();

    registry.add(sessionRecord({ persona: "worker" }));
    expect(() => updater.apply(LOCAL_SHA)).toThrowError(ApiError);
    try {
      updater.apply(LOCAL_SHA);
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
    }
    expect(spawns).toEqual([]);

    const worker = registry.list({ persona: "worker" })[0]!;
    registry.archive(worker.id);
    const reviewer = sessionRecord({ persona: "reviewer" });
    registry.add(reviewer);
    expect(() => updater.apply(LOCAL_SHA)).toThrowError(ApiError);

    registry.archive(reviewer.id);
    registry.add(sessionRecord({ persona: "orchestrator" }));
    expect(updater.apply(LOCAL_SHA)).toEqual({ ok: true });
    expect(spawns).toHaveLength(1);
  });

  it("applies a checkout update through the shim's update verb", () => {
    const { updater, spawns } = gateHarness();
    updater.apply(LOCAL_SHA);
    expect(spawns.at(-1)?.slice(1)).toEqual(["update"]);
  });

  it("restarts the service when only the running daemon is stale", () => {
    const { updater, spawns, setLocalSha } = gateHarness();
    setLocalSha(REMOTE_SHA);
    updater.apply(LOCAL_SHA);
    expect(spawns.at(-1)?.slice(1)).toEqual(["service", "restart"]);
  });
});
