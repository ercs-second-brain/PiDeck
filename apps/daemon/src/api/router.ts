/**
 * Minimal HTTP router over node's `http` module.
 *
 * Routes are path templates with `:name` segments (same convention as
 * `packages/shared` `endpoints`). Handlers return a status + JSON-serializable
 * body; they may also write the response themselves (streams, 204s) by
 * returning `undefined` after consuming `res`.
 */

import { ZodError } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Matched `:name` params (decoded). */
  params: Record<string, string>;
  /** Parsed JSON body when the request had one, else `undefined`. */
  body: unknown;
  /** Raw query string without the leading `?` (empty string when absent). */
  query: string;
}

interface RouteMatch {
  status?: number;
  /** JSON-serialized into the response unless `undefined` (handler wrote it). */
  body?: unknown;
}

export type RouteHandler = (ctx: RequestContext) => Promise<RouteMatch | void> | RouteMatch | void;

interface Route {
  method: string;
  /** Path segments; `:name` entries match one segment. */
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];

  /** Registers a handler for `method` + `template` (e.g. `/api/projects/:projectId`). */
  add(method: string, template: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(template), handler });
    return this;
  }

  /** Whether a route exists for method + concrete path (used by contract tests). */
  find(method: string, path: string): RouteHandler | undefined {
    return this.match(method.toUpperCase(), splitPath(path))?.handler;
  }

  private match(method: string, segments: string[]): { handler: RouteHandler; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const pattern = route.segments[i] as string;
        const actual = segments[i] as string;
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(actual);
        } else if (pattern !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return undefined;
  }

  /**
   * Dispatches `req`/`res`. Unmatched paths get 404; thrown errors get 500
   * (or their `statusCode` when set, e.g. `HttpError`).
   */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = splitPath(url.pathname);
    const found = this.match((req.method ?? "GET").toUpperCase(), segments);
    if (found === undefined) {
      sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
      return;
    }
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readJsonBody(req);
      const result = await found.handler({
        req,
        res,
        params: found.params,
        body,
        query: url.search.startsWith("?") ? url.search.slice(1) : "",
      });
      if (result === undefined) return; // handler wrote the response
      if (result.body === undefined && (result.status === undefined || result.status === 204)) {
        res.statusCode = result.status ?? 204;
        res.end();
        return;
      }
      sendJson(res, result.status ?? 200, result.body);
    } catch (err) {
      sendDispatchError(req, res, url.pathname, err);
    }
  }
}

/**
 * The dispatch error path (issue #351 F5, extracted from `dispatch`): a
 * half-written response is just closed; contract-validation failures
 * (`ZodError`) are client errors; everything else carries its numeric
 * `statusCode` ({@link HttpError} or any error shaped like one) or 500,
 * logged when server-side.
 */
function sendDispatchError(req: IncomingMessage, res: ServerResponse, pathname: string, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof ZodError) {
    // Contract request-body validation failure → client error.
    sendJson(res, 400, { error: `invalid request: ${err.message}` });
    return;
  }
  const status = errorStatus(err);
  const message = err instanceof Error ? err.message : String(err);
  if (status >= 500) console.error(`[api] ${req.method} ${pathname} failed:`, err);
  sendJson(res, status, { error: message });
}

/** The HTTP status for a thrown error: an explicit numeric `statusCode` (e.g. `HttpError`) wins, else 500. */
function errorStatus(err: unknown): number {
  return err instanceof HttpError
    ? err.statusCode
    : typeof (err as { statusCode?: unknown }).statusCode === "number"
      ? (err as { statusCode: number }).statusCode
      : 500;
}

/** Error carrying an HTTP status code (rendered as `{ error }` JSON). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}
