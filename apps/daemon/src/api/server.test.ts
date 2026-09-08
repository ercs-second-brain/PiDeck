/**
 * Static-serving and SPA-fallback behavior of the daemon HTTP server
 * (issue #73): the status page without a webapp build, the index.html SPA
 * fallback with one, and the 404 matrix when nothing can be served.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDaemonServer } from "./server.js";
import { testDaemon, type TestDaemon } from "./testutil.js";

/** Builds a daemon server over a tmp webapp dist dir and returns its base URL. */
async function startServer(webDist: string | null): Promise<{ base: string; daemon: TestDaemon; server: import("node:http").Server; router: ReturnType<typeof createDaemonServer>["router"] }> {
  const daemon = testDaemon();
  const { server, router } = createDaemonServer({ services: daemon.services, webDist });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  return { base, daemon, server, router };
}

async function stopServer(server: import("node:http").Server, daemon: TestDaemon): Promise<void> {
  daemon.services.hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("static serving + SPA fallback", () => {
  let noDist: Awaited<ReturnType<typeof startServer>>;
  let withIndex: Awaited<ReturnType<typeof startServer>>;
  let emptyDist: Awaited<ReturnType<typeof startServer>>;
  let webDistDir: string;
  let emptyDistDir: string;

  beforeAll(async () => {
    noDist = await startServer(null);

    webDistDir = path.join(tmpdir(), `pideck-web-dist-${process.pid}`);
    mkdirSync(webDistDir, { recursive: true });
    writeFileSync(path.join(webDistDir, "index.html"), "<html>pideck spa</html>");
    withIndex = await startServer(webDistDir);

    emptyDistDir = path.join(tmpdir(), `pideck-web-dist-empty-${process.pid}`);
    mkdirSync(emptyDistDir, { recursive: true });
    emptyDist = await startServer(emptyDistDir);
  });

  afterAll(async () => {
    await stopServer(noDist.server, noDist.daemon);
    await stopServer(withIndex.server, withIndex.daemon);
    await stopServer(emptyDist.server, emptyDist.daemon);
  });

  it("serves the daemon status page when no webapp build is configured", async () => {
    const res = await fetch(`${noDist.base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pideck daemon");
  });

  it("404s unclaimed API-ish paths (`/api` without the trailing slash)", async () => {
    const res = await fetch(`${noDist.base}/api`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("falls back to the SPA index for non-API paths when a webapp build is configured", async () => {
    const res = await fetch(`${withIndex.base}/some/client/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("pideck spa");
  });

  it("404s when a webDist is configured but has no index.html to fall back to", async () => {
    // Previously this answered 200 with a "not found" body — the inverted
    // ternary fixed in issue #73.
    const res = await fetch(`${emptyDist.base}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });
});

describe("slow-endpoint logging (issue #100 phase 1)", () => {
  it("logs /api requests that exceed the 500ms budget (and only those)", async () => {
    const { base, daemon, server, router } = await startServer(null);
    router.add("GET", "/api/slow-test", async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { body: { ok: true } };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await fetch(`${base}/api/slow-test`);
      await fetch(`${base}/api/status`);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[api\] slow GET \/api\/slow-test \d{3,}ms$/));
    } finally {
      warn.mockRestore();
      await stopServer(server, daemon);
    }
  });
});
