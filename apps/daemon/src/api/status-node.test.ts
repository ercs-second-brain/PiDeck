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
import { PiAuthProbe } from "../agent/pi-auth.js";
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

const fastPi: PiRunner = async () => ({ stdout: "", stderr: "" });

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
