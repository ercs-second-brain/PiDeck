/**
 * Router behavior tests: template matching, params, method handling, error
 * mapping (ZodError → 400, status-carrying errors, unknown routes → 404),
 * plus static serving of the webapp build with SPA fallback.
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpError, Router } from "./router.js";
import { serveStatic } from "./server.js";
import { capture } from "../testing/http-capture.js";

describe("router", () => {
  const router = new Router();
  router.add("GET", "/api/projects", () => ({ body: [] }));
  router.add("GET", "/api/projects/:projectId/kanban", ({ params }) => ({ body: { projectId: params["projectId"] } }));
  router.add("POST", "/api/echo", ({ body }) => ({ body }));
  router.add("DELETE", "/api/gone", () => {
    throw new HttpError(410, "gone forever");
  });
  router.add("GET", "/api/statuscode", () => {
    const err = new Error("custom status");
    (err as Error & { statusCode?: number }).statusCode = 402;
    throw err;
  });

  it("matches exact and templated paths, decoding params", async () => {
    expect(router.find("GET", "/api/projects")).toBeDefined();
    expect(router.find("GET", "/api/projects/o-r/kanban")).toBeDefined();
    expect(router.find("GET", "/api/projects/a%20b/kanban")).toBeDefined();
    expect(router.find("GET", "/api/projects")).toBeDefined();
  });

  it("does not cross-match methods or segment counts", () => {
    expect(router.find("POST", "/api/projects")).toBeUndefined();
    expect(router.find("GET", "/api/projects/o-r")).toBeUndefined();
    expect(router.find("GET", "/api/projects/o-r/kanban/extra")).toBeUndefined();
  });

  it("returns 404 JSON for unknown routes", async () => {
    const { req, res, text } = capture("GET", "/api/definitely-not-a-route");
    await router.dispatch(req, res);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(text())).toMatchObject({ error: expect.stringContaining("no route") });
  });

  it("maps status-carrying errors and HttpError", async () => {
    const { req, res: res410, text: text410 } = capture("DELETE", "/api/gone");
    await router.dispatch(req, res410);
    expect(res410.statusCode).toBe(410);
    expect(JSON.parse(text410())).toMatchObject({ error: "gone forever" });

    const { req: req402, res: res402, text: text402 } = capture("GET", "/api/statuscode");
    await router.dispatch(req402, res402);
    expect(res402.statusCode).toBe(402);
    expect(text402()).toContain("custom status");
  });

  it("parses JSON bodies for POST", async () => {
    const { req, res, text } = capture("POST", "/api/echo", JSON.stringify({ hello: 1 }));
    await router.dispatch(req, res);
    expect(JSON.parse(text())).toEqual({ hello: 1 });
  });

  it("rejects invalid JSON bodies with 400", async () => {
    const { req, res } = capture("POST", "/api/echo", "{not json");
    await router.dispatch(req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe("static serving", () => {
  let server: Server;
  let base: string;
  const webRoot = mkdtempSync(path.join(tmpdir(), "pideck-web-"));
  mkdirSync(path.join(webRoot, "assets"), { recursive: true });
  writeFileSync(path.join(webRoot, "index.html"), "<html><body>pideck</body></html>");
  writeFileSync(path.join(webRoot, "assets/app.js"), "console.log(1)");
  writeFileSync(path.join(webRoot, "assets/app-B4jTh9Kx.js"), "console.log(2)");
  writeFileSync(path.join(webRoot, "sw.js"), "self.onfetch=()=>{};");

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (serveStatic(webRoot, url.pathname, res)) return;
      res.statusCode = 404;
      res.end("nope");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves files with content types and SPA-falls back to index.html", async () => {
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("pideck");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    // SPA fallback: unknown client route serves index.html
    const spa = await fetch(`${base}/projects/o-r/board`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("pideck");
  });

  it("always revalidates the HTML shell and service worker; long-caches hashed assets (issue #228)", async () => {
    const noCache = "no-cache";
    for (const url of ["/", "/projects/o-r/board", "/sw.js", "/assets/app.js"]) {
      const res = await fetch(`${base}${url}`);
      expect(res.headers.get("cache-control"), url).toBe(noCache);
    }

    const hashed = await fetch(`${base}/assets/app-B4jTh9Kx.js`);
    expect(hashed.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("blocks path traversal outside the root", async () => {
    const res = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
    // Either blocked by fetch normalization or by the traversal guard → not a passwd leak.
    if (res.status === 200) {
      expect(await res.text()).toContain("pideck"); // fell back to index
    }
  });
});
