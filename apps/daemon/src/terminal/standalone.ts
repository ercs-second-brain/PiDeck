/**
 * Standalone dev harness for the Phase 1 web terminal (issue #7).
 *
 * Until the full daemon HTTP server lands (issue #13), this small process
 * serves everything the browser terminal needs:
 *
 * - `GET /api/projects` — projects derived from registered sessions
 *   (placeholder shapes; the real project store is issue #13).
 * - `GET /api/projects/:projectId/sessions` — session-registry listing.
 * - `POST /api/dev/orchestrator` `{projectId}` — creates the project's
 *   orchestrator tmux session for manual testing (dev-only convenience).
 * - `WS /ws` — the terminal bridge.
 * - Static files from `AGENTSKISS_WEB_DIST` (the built webapp), so the
 *   terminal page works end-to-end from one origin.
 *
 * Run: `pnpm --filter @agentskiss/daemon build && node dist/terminal/standalone.js`
 * Env: `AGENTSKISS_PORT` (default 8787), `AGENTSKISS_STATE_DIR`
 * (default `~/.agentskiss`), `AGENTSKISS_WEB_DIST` (optional path to
 * `apps/web/dist`).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { projectSchema } from "@agentskiss/shared";
import { DEFAULT_STATE_DIR, ProjectLayout } from "../sessions/layout.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionRegistry } from "../sessions/registry.js";
import { Tmux } from "../sessions/tmux.js";
import { TerminalBridge } from "./bridge.js";
import { attachTerminalWebSocket } from "./ws-server.js";

const port = Number(process.env["AGENTSKISS_PORT"] ?? 8787);
const stateDir = process.env["AGENTSKISS_STATE_DIR"] ?? DEFAULT_STATE_DIR;
const webDist = process.env["AGENTSKISS_WEB_DIST"];

const layout = new ProjectLayout(stateDir);
const registry = new SessionRegistry(layout.sessionsFilePath());
const tmux = new Tmux();
const manager = new SessionManager({ tmux, registry, layout });
const bridge = new TerminalBridge({ tmux, registry });

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

/** Derives placeholder project records from registered sessions. */
function deriveProjects(): unknown[] {
  const byProject = new Map<string, { createdAt: string; updatedAt: string }>();
  for (const session of registry.listSessions()) {
    const existing = byProject.get(session.projectId);
    if (!existing) {
      byProject.set(session.projectId, {
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
      });
    } else {
      existing.updatedAt = existing.updatedAt < session.createdAt ? session.createdAt : existing.updatedAt;
      existing.createdAt = existing.createdAt < session.createdAt ? existing.createdAt : session.createdAt;
    }
  }
  return [...byProject.entries()].map(([id, times]) =>
    projectSchema.parse({
      id,
      name: id,
      repoUrl: `https://github.com/agentskiss/local/${encodeURIComponent(id)}`,
      defaultBranch: "main",
      settings: { autoAgentUsername: null, workerConcurrency: 1 },
      createdAt: times.createdAt,
      updatedAt: times.updatedAt,
    }),
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (req.method === "GET" && pathname === "/api/projects") {
    sendJson(res, 200, deriveProjects());
    return true;
  }
  const sessionsMatch = /^\/api\/projects\/([^/]+)\/sessions$/.exec(pathname);
  if (req.method === "GET" && sessionsMatch) {
    const projectId = decodeURIComponent(sessionsMatch[1] ?? "");
    sendJson(res, 200, registry.listSessions({ projectId }));
    return true;
  }
  const workersMatch = /^\/api\/projects\/([^/]+)\/workers$/.exec(pathname);
  if (req.method === "GET" && workersMatch) {
    const projectId = decodeURIComponent(workersMatch[1] ?? "");
    sendJson(res, 200, registry.listWorkers({ projectId }));
    return true;
  }
  // Dev-only: create a tmux session to attach to (removed with issue #13).
  if (req.method === "POST" && pathname === "/api/dev/orchestrator") {
    let projectId = "dev";
    try {
      const parsed = JSON.parse(await readBody(req)) as { projectId?: string };
      if (typeof parsed.projectId === "string" && parsed.projectId.length > 0) projectId = parsed.projectId;
    } catch {
      // default project id
    }
    const session = await manager.ensureOrchestrator(projectId);
    sendJson(res, 200, session);
    return true;
  }
  return false;
}

function serveStatic(res: ServerResponse, pathname: string): void {
  if (!webDist) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><title>agentskiss daemon</title><p>Terminal WebSocket is live on <code>/ws</code>. " +
        "Set AGENTSKISS_WEB_DIST to serve the webapp.</p>",
    );
    return;
  }
  const relative = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(path.join(webDist, relative));
  if (!resolved.startsWith(path.resolve(webDist)) || !existsSync(resolved) || !statSync(resolved).isFile()) {
    // SPA fallback: let the client router handle unknown paths.
    const index = path.join(webDist, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      createReadStream(index).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const type = MIME_TYPES[path.extname(resolved)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  createReadStream(resolved).pipe(res);
}

const server = createServer((req, res) => {
  void (async () => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    if (await handleApi(req, res, pathname).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    })) {
      return;
    }
    serveStatic(res, pathname);
  })();
});

attachTerminalWebSocket(server, bridge);

server.listen(port, () => {
  console.log(`agentskiss terminal harness: http://localhost:${port} (ws: /ws, state: ${stateDir})`);
});
