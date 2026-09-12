/**
 * Typed client for the daemon's REST and WebSocket API. Shapes come from
 * `@pideck/shared` and are never restated here: `api()` speaks the shared
 * `restEndpoints` table (path params substituted, request bodies and
 * responses schema-validated), `watchServer()` owns the single /ws socket
 * for the app shell and dispatches `sessions.changed` and `projects.changed`.
 * Terminal panes open their own connection (see src/terminal/connection.ts).
 */

import { z } from "zod";
import {
  restEndpoints,
  WsServerMessageSchema,
  type Project,
  type RestEndpointName,
  type SessionView,
} from "@pideck/shared";
import { nextBackoffMs } from "../terminal/backoff";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Endpoint = (typeof restEndpoints)[RestEndpointName];
type ResponseOf<Name extends RestEndpointName> = z.output<(typeof restEndpoints)[Name]["response"]>;

function resolvePath(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`Missing :${key} for ${path}`);
    return encodeURIComponent(value);
  });
}

/** Typed call against the shared endpoint table; responses are validated. */
export async function api<Name extends RestEndpointName>(
  name: Name,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<ResponseOf<Name>> {
  const endpoint: Endpoint = restEndpoints[name];
  const response = await fetch(resolvePath(endpoint.path, params), {
    method: endpoint.method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, `${endpoint.method} ${endpoint.path} failed (${response.status})`);
  }
  const parsed = endpoint.response.safeParse(await response.json());
  if (!parsed.success) {
    throw new ApiError(response.status, "Unexpected response from the daemon");
  }
  return parsed.data as ResponseOf<Name>;
}

function wsUrl(): string {
  const secure = window.location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${window.location.host}/ws`;
}

export type SessionsHandler = (sessions: SessionView[]) => void;
export type ProjectsHandler = (projects: Project[]) => void;

export interface ServerWatchHandlers {
  onSessions: SessionsHandler;
  onProjects: ProjectsHandler;
}

export type WebSocketFactory = new (url: string) => WebSocket;

/**
 * Subscribes the shell to the daemon's push channel: opens /ws, hands every
 * `sessions.changed` / `projects.changed` snapshot to its handler (the daemon
 * sends both current snapshots on connect), ignores other server messages,
 * and reconnects with jittered backoff after an unexpected close. Returns
 * the unsubscribe function.
 */
export function watchServer(
  handlers: ServerWatchHandlers,
  url: string = wsUrl(),
  WebSocketImpl: WebSocketFactory = WebSocket,
): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (closed) return;
    const socket = new WebSocketImpl(url);
    ws = socket;
    socket.onopen = () => {
      attempt = 0;
    };
    socket.onmessage = (event) => {
      let json: unknown;
      try {
        json = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const message = WsServerMessageSchema.safeParse(json);
      if (!message.success) return;
      if (message.data.type === "sessions.changed") handlers.onSessions(message.data.sessions);
      if (message.data.type === "projects.changed") handlers.onProjects(message.data.projects);
    };
    socket.onclose = () => {
      if (closed || ws !== socket) return;
      ws = null;
      attempt += 1;
      timer = setTimeout(open, nextBackoffMs(attempt));
    };
  };

  open();
  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    if (ws !== null) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  };
}
