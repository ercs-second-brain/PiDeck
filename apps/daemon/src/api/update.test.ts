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
  setLocalSha: (sha: string) => void;
  setRemoteSha: (sha: string) => void;
}

function makeHarness(options: { configJson?: string } = {}): Harness {
  const stateDir = tempStateDir();
  dirs.push(stateDir);
  const calls: string[][] = [];
  const spawns: string[][] = [];
  let localSha = LOCAL_SHA;
  let remoteSha = REMOTE_SHA;
  let clock = 0;
  const run: UpdateRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "rev-parse") return { stdout: `${localSha}\n` };
    if (cmd === "git" && args[0] === "remote") {
      return { stdout: "https://github.com/acme/widget.git\n" };
    }
    if (cmd === "gh") return { stdout: `${remoteSha}\n` };
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
    setLocalSha: (sha) => {
      localSha = sha;
    },
    setRemoteSha: (sha) => {
      remoteSha = sha;
    },
  };
}

describe("update check", () => {
  it("reports an update when the checkout is behind the upstream ref", () => {
    const h = makeHarness();
    expect(h.updater.check()).toEqual({ updateAvailable: true, latestVersion: "bbbbbbb" });
    expect(h.calls).toContainEqual(["gh", "api", "repos/acme/widget/commits/main", "--jq", ".sha"]);
  });

  it("reports up to date when HEAD matches the upstream ref", () => {
    const h = makeHarness();
    h.setLocalSha(REMOTE_SHA);
    expect(h.updater.check()).toEqual({ updateAvailable: false, latestVersion: "bbbbbbb" });
  });

  it("takes repoUrl and repoRef from the install's config.json when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "pideck-update-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ repoUrl: "git@github.com:acme/fork.git", repoRef: "release" }),
    );
    const h = makeHarness({ configJson: join(dir, "config.json") });
    h.updater.check();
    expect(h.calls).toContainEqual(["gh", "api", "repos/acme/fork/commits/release", "--jq", ".sha"]);
    expect(h.calls).not.toContainEqual(["git", "remote", "get-url", "origin"]);
  });

  it("caches a successful check for about an hour", () => {
    const h = makeHarness();
    h.updater.check();
    const afterFirst = h.calls.length;

    h.setClock(30 * 60 * 1000);
    h.updater.check();
    expect(h.calls).toHaveLength(afterFirst);

    h.setClock(61 * 60 * 1000);
    h.updater.check();
    expect(h.calls.length).toBeGreaterThan(afterFirst);
  });

  it("does not serve a stale check after the upstream moved", () => {
    const h = makeHarness();
    expect(h.updater.check()).toEqual({ updateAvailable: true, latestVersion: "bbbbbbb" });
    h.setLocalSha(REMOTE_SHA);
    h.setClock(61 * 60 * 1000);
    expect(h.updater.check()).toEqual({ updateAvailable: false, latestVersion: "bbbbbbb" });
  });
});

describe("update apply gate", () => {
  it("refuses while a worker or reviewer session is live", () => {
    const stateDir = tempStateDir();
    dirs.push(stateDir);
    const registry = new SessionRegistry(stateDir);
    const spawns: string[][] = [];
    const updater = createUpdater({
      srcDir: stateDir,
      registry,
      run: () => ({ stdout: "" }),
      spawn: (cmd, args) => {
        spawns.push([cmd, ...args]);
      },
    });

    registry.add(sessionRecord({ persona: "worker" }));
    expect(() => updater.apply()).toThrowError(ApiError);
    try {
      updater.apply();
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
    }
    expect(spawns).toEqual([]);

    const worker = registry.list({ persona: "worker" })[0]!;
    registry.archive(worker.id);
    const reviewer = sessionRecord({ persona: "reviewer" });
    registry.add(reviewer);
    expect(() => updater.apply()).toThrowError(ApiError);

    registry.archive(reviewer.id);
    registry.add(sessionRecord({ persona: "orchestrator" }));
    expect(updater.apply()).toEqual({ ok: true });
    expect(spawns).toHaveLength(1);
  });
});
