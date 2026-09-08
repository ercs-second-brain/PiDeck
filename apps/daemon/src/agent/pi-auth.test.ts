/**
 * Tests for the pi auth probe (issue #57): hermetic — the pi CLI is faked
 * with an in-memory runner keyed by provider, mirroring how the gh probe
 * tests fake the gh runner. One test spawns a guaranteed-missing binary to
 * pin the pi-not-installed path.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  PiAuthProbe,
  PiNotInstalledError,
  piAuthPayloadFrom,
  piReadyProviders,
  providerAuthReady,
  readPiStartupDefaults,
  spawnPi,
  type PiRunner,
} from "./pi-auth.js";

/** Fake pi CLI: returns a per-provider stdout, or throws when configured to. */
function fakePi(auth: Record<string, string> = {}): PiRunner {
  return async (args) => {
    if (args[0] !== "auth" || args[1] !== "check") throw new Error(`fake pi: unexpected args ${args.join(" ")}`);
    const provider = args[3] ?? "";
    if (provider in auth) return { stdout: auth[provider] ?? "", stderr: "" };
    return { stdout: "", stderr: "" };
  };
}

describe("providerAuthReady", () => {
  it("matches the ready marker with either JSON spacing (mirrors onboard.sh)", () => {
    expect(providerAuthReady('{"status":"ready","provider":"anthropic"}')).toBe(true);
    expect(providerAuthReady('{ "status": "ready", "provider": "anthropic" }')).toBe(true);
    expect(providerAuthReady('{"status":"not_ready","provider":"anthropic","reason":"provider_not_found"}')).toBe(false);
    expect(providerAuthReady("")).toBe(false);
  });
});

describe("piReadyProviders", () => {
  it("collects ready providers in the canonical provider order", async () => {
    const ready = await piReadyProviders(
      fakePi({
        zai: '{"status":"ready"}',
        anthropic: '{"status":"ready"}',
        openai: '{"status":"not_ready","reason":"credentials_not_configured"}',
      }),
    );
    // anthropic precedes zai in PI_PROVIDERS regardless of probe order.
    expect(ready).toEqual(["anthropic", "zai"]);
  });

  it("reports none ready when every probe fails", async () => {
    const ready = await piReadyProviders(fakePi({}));
    expect(ready).toEqual([]);
  });
});

describe("spawnPi", () => {
  it("rejects with PiNotInstalledError when the pi binary is missing", async () => {
    const saved = process.env["PATH"];
    try {
      process.env["PATH"] = "";
      await expect(spawnPi(["--version"])).rejects.toBeInstanceOf(PiNotInstalledError);
    } finally {
      if (saved !== undefined) process.env["PATH"] = saved;
    }
  });
});

describe("readPiStartupDefaults", () => {
  it("reads defaultProvider/defaultModel from pi's settings.json", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-settings-"));
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" }),
    );
    expect(readPiStartupDefaults(dir)).toEqual({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" });
  });

  it("degrades to nulls for a missing or malformed settings file", () => {
    expect(readPiStartupDefaults(path.join(tmpdir(), "pi-missing-dir"))).toEqual({
      defaultProvider: null,
      defaultModel: null,
    });
  });
});

describe("piAuthPayloadFrom", () => {
  it("builds the shared PiAuth body with an actionable detail", () => {
    expect(piAuthPayloadFrom(["anthropic"], true, { defaultProvider: "anthropic", defaultModel: "m" })).toEqual({
      ready: true,
      providers: ["anthropic"],
      defaultProvider: "anthropic",
      defaultModel: "m",
      detail: expect.stringContaining("credentials ready"),
    });
    expect(piAuthPayloadFrom([], true, { defaultProvider: null, defaultModel: null }).detail).toContain("pideck onboard");
    expect(piAuthPayloadFrom([], false, { defaultProvider: null, defaultModel: null }).detail).toContain("not installed");
  });
});

describe("PiAuthProbe", () => {
  it("reports ready with providers and the configured model", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-settings-"));
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultModel: "claude-sonnet-4-5" }));
    const probe = new PiAuthProbe({ run: fakePi({ anthropic: '{"status":"ready"}' }), piDir: dir, ttlMs: 0 });
    const payload = await probe.payload();
    expect(payload.ready).toBe(true);
    expect(payload.providers).toEqual(["anthropic"]);
    expect(payload.defaultModel).toBe("claude-sonnet-4-5");
  });

  it("reports not-ready (never throws) when the pi CLI is missing", async () => {
    const probe = new PiAuthProbe({
      run: async () => {
        throw new PiNotInstalledError("pi CLI not found on PATH");
      },
      ttlMs: 0,
    });
    const payload = await probe.payload();
    expect(payload.ready).toBe(false);
    expect(payload.providers).toEqual([]);
    expect(payload.detail).toContain("not installed");
  });

  it("caches within the TTL and re-probes after it (and after invalidate)", async () => {
    let clock = 1_000;
    let passes = 0;
    const run: PiRunner = async (args) => {
      if (args[3] === "anthropic") passes += 1; // count probe passes, not per-provider calls
      void args;
      return { stdout: '{"status":"ready"}', stderr: "" };
    };
    const probe = new PiAuthProbe({ run, ttlMs: 30_000, now: () => clock });
    await probe.payload();
    await probe.payload();
    expect(passes).toBe(1);
    clock += 30_001;
    // Stale-while-revalidate (issue #100): the stale payload is served
    // immediately; the refresh runs in the background.
    await probe.payload();
    await vi.waitFor(() => expect(passes).toBe(2));
    // Let the background refresh fully settle before invalidating.
    await new Promise((resolve) => setTimeout(resolve, 2));
    probe.invalidate();
    await probe.payload();
    expect(passes).toBe(3);
  });

  it("coalesces concurrent probes into one pass", async () => {
    let passes = 0;
    const run: PiRunner = async (args) => {
      if (args[3] === "anthropic") passes += 1; // count probe passes, not per-provider calls
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { stdout: '{"status":"ready"}', stderr: "" };
    };
    const probe = new PiAuthProbe({ run, ttlMs: 0 });
    const [a, b] = await Promise.all([probe.payload(), probe.payload()]);
    expect(a.ready).toBe(b.ready);
    expect(passes).toBe(1);
  });

  it("honors the readyOverride test hook without probing", async () => {
    let calls = 0;
    const probe = new PiAuthProbe({
      run: async () => {
        calls += 1;
        return { stdout: "", stderr: "" };
      },
      readyOverride: true,
    });
    const payload = await probe.payload();
    expect(payload.ready).toBe(true);
    expect(payload.providers).toEqual(["anthropic"]);
    expect(calls).toBe(0);
  });
});

describe("piReadyProviders: parallel probe (issue #100)", () => {
  it("runs all provider checks concurrently, not serially", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const run: PiRunner = async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 50));
      running -= 1;
      return { stdout: "", stderr: "" };
    };
    const start = Date.now();
    const ready = await piReadyProviders(run);
    const elapsed = Date.now() - start;
    expect(ready).toEqual([]);
    expect(maxConcurrent).toBe(13); // all providers probed at once
    // Serial probing (the pre-#100 behavior) measured ~139s on a user's Mac;
    // parallel must cost one pi invocation, not 13.
    expect(elapsed).toBeLessThan(13 * 50);
  });
});

describe("PiAuthProbe: stale-while-revalidate (issue #100)", () => {
  const SLOW_MS = 50;

  /** Probe with a per-provider runner slow enough to measure against. */
  function slowProbe(ttlMs: number, clock?: () => number): {
    probe: PiAuthProbe;
    counts: () => { passes: number; maxConcurrent: number };
  } {
    let passes = 0;
    let running = 0;
    let maxConcurrent = 0;
    const run: PiRunner = async (args) => {
      if (args[3] === "anthropic") {
        passes += 1;
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
      }
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      if (args[3] === "anthropic") running -= 1;
      return { stdout: '{"status":"ready"}', stderr: "" };
    };
    return {
      probe: new PiAuthProbe({ run, ttlMs, ...(clock ? { now: clock } : {}) }),
      counts: () => ({ passes, maxConcurrent }),
    };
  }

  it("serves a stale payload in <10ms and refreshes in the background", async () => {
    const { probe, counts } = slowProbe(30);
    await probe.payload(); // cold: the one awaited probe pass
    expect(counts().passes).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40)); // TTL expires

    const startedAt = Date.now();
    const payload = await probe.payload();
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(10); // request path never waits on a probe
    expect(payload.ready).toBe(true);
    expect(payload.stale).toBe(true);
    await vi.waitFor(() => expect(counts().passes).toBe(2)); // refresh landed
  });

  it("never stacks background refreshes (single-flight)", async () => {
    let clock = 1_000;
    const { probe, counts } = slowProbe(30_000, () => clock);
    await probe.payload();
    clock += 30_001; // stale
    await Promise.all([probe.payload(), probe.payload(), probe.payload(), probe.payload(), probe.payload()]);
    expect(counts().maxConcurrent).toBe(1);
    await vi.waitFor(() => expect(counts().passes).toBe(2));
  });

  it("caches the not-ready verdict when the pi CLI fails (no re-probe storm)", async () => {
    let calls = 0;
    const probe = new PiAuthProbe({
      run: async () => {
        calls += 1;
        throw new Error("pi exploded");
      },
      ttlMs: 30_000,
    });
    const failed = await probe.payload();
    expect(failed.ready).toBe(false);
    // A failing run for one provider just means that provider is not ready.
    expect(failed.detail).toContain("no ready pi provider");
    await probe.payload();
    // 13 providers probed once; the verdict is served from cache after that.
    expect(calls).toBe(13);
  });
});
