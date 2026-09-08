/**
 * Daemon HTTP server: contract + CLI routes, static serving of the webapp
 * build output (SPA fallback to index.html), and the `/api/ws` websocket
 * upgrade handled by the {@link WsHub}.
 */

import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Router } from "./router.js";
import { contractHandlers, registerContractRoutes } from "./handlers.js";
import { registerCliRoutes } from "./cli-handlers.js";
import { registerGhAuthRoute } from "./gh-auth.js";
import { registerOnboardingRoute } from "./onboarding.js";
import type { DaemonServices } from "./context.js";
import { WS_PATH } from "./ws.js";
import { TERMINAL_WS_PATH } from "../terminal/ws-server.js";

export interface DaemonServerOptions {
  services: DaemonServices;
  /** Directory containing the built webapp (`apps/web/dist`). `null` disables static serving. */
  webDist?: string | null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createDaemonServer(options: DaemonServerOptions): { server: Server; router: Router } {
  const { services } = options;
  const router = new Router();
  registerContractRoutes(router, contractHandlers(services));
  registerCliRoutes(router, services);
  registerGhAuthRoute(router);
  registerOnboardingRoute(router, services);
  const webDist = options.webDist === undefined ? defaultWebDist() : options.webDist;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // API paths go through the router; everything else is the webapp SPA.
      if (url.pathname.startsWith("/api/")) {
        const startedAt = Date.now();
        try {
          await router.dispatch(req, res);
        } finally {
          logSlowEndpoint(req.method ?? "GET", url.pathname, Date.now() - startedAt);
        }
        return;
      }
      const webDistConfigured = webDist !== null && webDist !== undefined && webDist.length > 0;
      if (webDistConfigured) {
        if (serveStatic(webDist, url.pathname, res)) return;
      }
      // Reaching this point means nothing could be served: either an API-ish
      // path the router does not claim ("/api" without the trailing slash,
      // "/api<unknown>"), or a configured webDist whose static serving fell
      // through (traversal guard, or no index.html to fall back to) — both
      // are 404s. Only with no webapp build at all does "/" double as the
      // daemon's plain-text status page.
      const notFound = webDistConfigured || url.pathname.startsWith("/api");
      res.statusCode = notFound ? 404 : 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(notFound ? "not found" : "pideck daemon");
    })().catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      } else {
        res.end();
      }
    });
  });

  services.hub.attach(server);
  // Destroy upgrade requests for paths neither the kanban hub (/api/ws) nor
  // the terminal bridge (/ws, attached by the entry point) claims.
  server.on("upgrade", (req, socket) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== WS_PATH && pathname !== TERMINAL_WS_PATH) socket.destroy();
  });
  return { server, router };
}

/** Requests slower than this are logged (issue #100 phase 1). */
const SLOW_ENDPOINT_MS = 500;

/** Logs one API request when it exceeded the slow-endpoint budget. */
function logSlowEndpoint(method: string, pathname: string, durationMs: number): void {
  if (durationMs < SLOW_ENDPOINT_MS) return;
  console.warn(`[api] slow ${method} ${pathname} ${durationMs}ms`);
}

/** Resolves the default webapp dist dir relative to the daemon package (`apps/web/dist`). */
export function defaultWebDist(): string | undefined {
  const fromEnv = process.env["PD_WEB_DIST"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  // This module lives at <repo>/apps/daemon/{src/api,dist/api}/server.js;
  // the webapp build is <repo>/apps/web/dist.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "../../../web/dist");
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Cache lifetime for content-hashed assets (vite emits `<name>-<hash>.<ext>`):
 * effectively forever — a changed file always gets a new name.
 */
const HASHED_ASSET_MAX_AGE = "public, max-age=31536000, immutable";

/**
 * Cache-Control for a served static file (issue #228). The HTML shell and the
 * service worker must always revalidate — a stale shell survives rebrands and
 * breaks the update flow. Vite-hashed assets are immutable and long-cached;
 * everything else (icons, manifest, offline fallback) revalidates too.
 */
function cacheControlFor(filePath: string): string {
  if (/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(path.basename(filePath))) return HASHED_ASSET_MAX_AGE;
  return "no-cache";
}

/** Serves a static file from `root`; SPA fallback to index.html. Returns false when nothing served. */
export function serveStatic(root: string, pathname: string, res: import("node:http").ServerResponse): boolean {
  const decoded = decodeURIComponent(pathname);
  let filePath = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (!filePath.startsWith(path.resolve(root))) return false; // traversal guard
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    const index = path.join(root, "index.html");
    if (!existsSync(index)) return false;
    filePath = index;
  }
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", cacheControlFor(filePath));
  createReadStream(filePath).pipe(res);
  return true;
}
