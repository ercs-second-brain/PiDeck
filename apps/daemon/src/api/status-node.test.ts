/**
 * `/api/status` node-runtime fields (issue #202): the daemon reports which
 * node it actually runs on (`nodeVersion`) and whether that is too old for
 * the pi sessions it spawns (`nodeTooOld`, pi needs >= 22.19) — a daemon
 * booted on a stale private runtime must be diagnosable from the API alone,
 * without waiting for the `zlib.createZstdDecompress` crash in every worker.
 */

import { describe, expect, it } from "vitest";

import { capture } from "../testing/http-capture.js";
import type { PiRunner } from "../agent/pi-auth.js";
import { PiAuthProbe, PiNotInstalledError } from "../agent/pi-auth.js";
import type { DaemonServices } from "./context.js";
import { nodeSupportsPi } from "./node-version.js";
import { Router } from "./router.js";
import { registerCliRoutes } from "./cli-handlers.js";

/** Minimal services surface registerCliRoutes touches for /api/status. */
function stubServices(piAuth: PiAuthProbe): DaemonServices {
  return {
    projects: { list: () => [] },
    sessions: { listSessions: () => [] },
    piAuth,
    runtimeStats: {
      snapshot: () => ({
        uptimeSeconds: 1,
        rssBytes: 1,
        heapUsedBytes: 1,
        eventLoopLagP99Ms: 0,
        eventLoopLagMaxMs: 0,
      }),
    },
    now: () => new Date(),
  } as unknown as DaemonServices;
}

const fastPi: PiRunner = async (args) => ({
  // `pi --version` (issue #223): a parseable version line. Auth probes get
  // the same output and simply parse as not-ready, which this suite ignores.
  stdout: args[0] === "--version" ? "0.85.1\n" : "",
  stderr: "",
});

async function statusBody(): Promise<Record<string, unknown>> {
  const router = new Router();
  registerCliRoutes(router, stubServices(new PiAuthProbe({ run: fastPi })));
  const captured = capture("GET", "/api/status");
  await router.dispatch(captured.req, captured.res);
  return JSON.parse(captured.text()) as Record<string, unknown>;
}

describe("GET /api/status node fields (issue #202)", () => {
  it("reports the running node version and whether pi can run on it", async () => {
    const body = await statusBody();
    expect(body["nodeVersion"]).toBe(process.version);
    expect(body["nodeTooOld"]).toBe(!nodeSupportsPi(process.version));
  });
});

describe("GET /api/status piVersion (issue #223)", () => {
  it("reports the installed pi version next to the node fields", async () => {
    const body = await statusBody();
    expect(body["piVersion"]).toBe("0.85.1");
  });

  it("memoizes the version probe — repeated status polls spawn pi once", async () => {
    let runs = 0;
    const counting: PiRunner = async (args) => {
      if (args[0] === "--version") runs += 1;
      return { stdout: "0.85.1\n", stderr: "" };
    };
    const probe = new PiAuthProbe({ run: counting });
    expect(await probe.version()).toBe("0.85.1");
    expect(await probe.version()).toBe("0.85.1");
    expect(runs).toBe(1);
  });

  it("reads a missing/broken pi as null instead of failing the status route", async () => {
    const probe = new PiAuthProbe({
      run: async () => {
        throw new PiNotInstalledError("pi CLI not found on PATH");
      },
    });
    await expect(probe.version()).resolves.toBeNull();
  });
});
