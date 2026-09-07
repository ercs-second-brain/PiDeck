/**
 * /api/status request-path latency regression test (issue #100).
 *
 * The webapp polls /api/status continuously; the pi-auth probe it awaits can
 * cost one pi spawn per provider (measured at ~139s serial on a user's Mac).
 * The probe now runs in parallel and serves stale-while-revalidate — this
 * test pins the steady-state cost: once the probe has run once, /api/status
 * (and every other payload() call site: /api/pi-auth, the worker-spawn
 * readiness gate, the prompt gate) must respond in single-digit
 * milliseconds, never spawning pi processes.
 */

import { describe, expect, it } from "vitest";
import type { PiRunner } from "../agent/pi-auth.js";
import { PiAuthProbe } from "../agent/pi-auth.js";
import { capture } from "../testing/http-capture.js";
import { Router } from "./router.js";
import { registerCliRoutes } from "./cli-handlers.js";
import type { DaemonServices } from "./context.js";

const SLOW_MS = 50;

/** A runner as slow as the real pi CLI on a struggling host, but hermetic. */
const slowPi: PiRunner = async () => {
  await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
  return { stdout: "", stderr: "" };
};

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

function statusRouter(piAuth: PiAuthProbe): Router {
  const router = new Router();
  registerCliRoutes(router, stubServices(piAuth));
  return router;
}

describe("GET /api/status latency (issue #100)", () => {
  it("never blocks on a probe once one has run — steady state < 10ms", async () => {
    const router = statusRouter(new PiAuthProbe({ run: slowPi }));

    // First hit: the single cold probe pass (all providers in parallel,
    // ~SLOW_MS total) is awaited once; concurrent first hits dedupe onto it.
    const [first, concurrent] = await Promise.all([
      (async () => {
        const captured = capture("GET", "/api/status");
        await router.dispatch(captured.req, captured.res);
        return captured;
      })(),
      (async () => {
        const captured = capture("GET", "/api/status");
        await router.dispatch(captured.req, captured.res);
        return captured;
      })(),
    ]);
    expect(first.status()).toBe(200);
    const body = JSON.parse(first.text()) as { ok: boolean; piReady: boolean };
    expect(body).toMatchObject({ ok: true });
    expect(concurrent.status()).toBe(200);

    // Steady state: served from cache, single-digit milliseconds.
    const warm = capture("GET", "/api/status");
    const startedAt = Date.now();
    await router.dispatch(warm.req, warm.res);
    expect(Date.now() - startedAt).toBeLessThan(10);
    expect(warm.status()).toBe(200);
  });
});
