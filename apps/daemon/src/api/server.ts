import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { TerminalBridge } from "../terminal/bridge.js";
import type { DaemonDeps } from "./deps.js";
import { buildApiHandlers } from "./routes.js";
import { routeRequest, type Routed } from "./router.js";
import { lookupStaticFile } from "./static.js";
import { mountWs, SessionsHub } from "./ws.js";
import { sessionViews } from "./views.js";

export interface ServeOptions {
  host?: string;
  port?: number;
  /** Directory of the built web app; `null` (default) disables static serving. */
  webDistDir?: string | null;
  /** Hub snapshot-poll interval (ms). */
  pollMs?: number;
  /** Hub broadcast debounce (ms). */
  debounceMs?: number;
  /** Heartbeat ping interval (ms); `0` disables it. */
  heartbeatMs?: number;
}

export interface DaemonServer {
  host: string;
  port: number;
  hub: SessionsHub;
  /** Closes sockets, the terminal bridge and the HTTP listener. */
  close(): Promise<void>;
}

/**
 * Assembles the daemon's HTTP surface: the REST router, static web app
 * serving, and one WebSocket at /ws shared by the terminal bridge and the
 * sessions hub. The hub's snapshot poll broadcasts registry changes from any
 * source, so callers never need to instrument the registry.
 */
export async function serve(deps: DaemonDeps, options: ServeOptions = {}): Promise<DaemonServer> {
  const bridge = new TerminalBridge({
    sessions: deps.registry,
    tmux: deps.tmux,
  });
  const hub = new SessionsHub({
    snapshot: () => sessionViews(deps.registry.all(), deps),
    debounceMs: options.debounceMs ?? 100,
  });
  deps.notifyChange = () => hub.broadcastSoon();
  const handlers = buildApiHandlers(deps);
  const webDistDir = options.webDistDir ?? null;

  const server: HttpServer = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    let routed: Routed;
    try {
      routed = await routeRequest(handlers, req);
    } catch (err) {
      routed = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
    if (routed.status === 404 && webDistDir !== null && !url.pathname.startsWith("/api/")) {
      const file = lookupStaticFile(webDistDir, req.url ?? "/");
      if (file) {
        res.writeHead(200, { "content-type": file.contentType });
        res.end(file.body);
        return;
      }
    }
    res.writeHead(routed.status, { "content-type": "application/json" });
    res.end(JSON.stringify(routed.body));
  }

  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8321;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  const stopWs = mountWs(server, bridge, hub, { heartbeatMs: options.heartbeatMs });
  hub.startPolling(options.pollMs ?? 2000);

  return {
    host,
    port: boundPort,
    hub,
    async close() {
      hub.close();
      stopWs();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      bridge.dispose();
    },
  };
}