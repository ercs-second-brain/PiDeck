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
import { contractHandlers, registerCliRoutes, registerContractRoutes } from "./handlers.js";
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
  const webDist = options.webDist === undefined ? defaultWebDist() : options.webDist;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // API paths go through the router; everything else is the webapp SPA.
      if (url.pathname.startsWith("/api/")) {
        await router.dispatch(req, res);
        return;
      }
      if (webDist !== null && webDist !== undefined && webDist.length > 0) {
        if (serveStatic(webDist, url.pathname, res)) return;
      }
      res.statusCode = req.url?.startsWith("/api") === true ? 404 : 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(webDist !== null && webDist !== undefined && webDist.length > 0 ? "not found" : "agentskiss daemon");
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

/** Resolves the default webapp dist dir relative to the daemon package (`apps/web/dist`). */
export function defaultWebDist(): string | undefined {
  const fromEnv = process.env["AGENTSKISS_WEB_DIST"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  // This module lives at <repo>/apps/daemon/{src/api,dist/api}/server.js;
  // the webapp build is <repo>/apps/web/dist.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "../../../web/dist");
  return existsSync(candidate) ? candidate : undefined;
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
  createReadStream(filePath).pipe(res);
  return true;
}
