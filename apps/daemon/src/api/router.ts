import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { restEndpoints, type RestEndpoint, type RestEndpointName } from "@pideck/shared";

/** An error with a meaning status code for the HTTP response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ApiContext {
  params: Record<string, string>;
  body: unknown;
}

type ApiHandler = (ctx: ApiContext) => unknown | Promise<unknown>;

/**
 * One handler per shared endpoint. A missing handler answers 501 — that is
 * how not-yet-implemented endpoints stay visible in the contract.
 */
export type ApiHandlers = { [K in RestEndpointName]?: ApiHandler };

const MAX_BODY_BYTES = 1024 * 1024;

interface Route {
  name: RestEndpointName;
  method: string;
  segments: string[];
  request: z.ZodType | undefined;
  response: z.ZodType;
}

const routes: Route[] = (
  Object.entries(restEndpoints) as [RestEndpointName, RestEndpoint][]
).map(([name, endpoint]) => ({
  name,
  method: endpoint.method,
  segments: endpoint.path.split("/").filter((segment) => segment.length > 0),
  request: endpoint.request,
  response: endpoint.response,
}));

export interface Routed {
  status: number;
  body: unknown;
}

/**
 * Routes one HTTP request through the shared endpoint map: path params are
 * matched against the endpoint paths, request bodies are validated with the
 * endpoint's request schema, and every response body is validated with the
 * endpoint's response schema before it is serialized.
 */
export async function routeRequest(
  handlers: ApiHandlers,
  req: IncomingMessage,
): Promise<Routed> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const matched = match(req.method ?? "GET", url.pathname);
  if (!matched) {
    return { status: 404, body: { error: `no route for ${req.method} ${url.pathname}` } };
  }
  const handler = handlers[matched.name];
  if (!handler) {
    return { status: 501, body: { error: "not implemented" } };
  }
  try {
    const body = matched.request ? await parseBody(req, matched.request) : undefined;
    const result = await handler({ params: matched.params, body });
    return { status: 200, body: matched.response.parse(result) };
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, body: { error: err.message } };
    if (err instanceof z.ZodError) {
      return {
        status: 500,
        body: { error: `response violates the endpoint contract: ${z.prettifyError(err)}` },
      };
    }
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}

function match(method: string, pathname: string): { name: RestEndpointName; request: z.ZodType | undefined; response: z.ZodType; params: Record<string, string> } | null {
  const segments = pathname.replace(/\/+$/, "").split("/").filter((s) => s.length > 0);
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let hit = true;
    for (let i = 0; i < segments.length; i++) {
      const pattern = route.segments[i]!;
      const actual = segments[i]!;
      if (pattern.startsWith(":")) params[pattern.slice(1)] = actual;
      else if (pattern !== actual) {
        hit = false;
        break;
      }
    }
    if (hit) return { name: route.name, request: route.request, response: route.response, params };
  }
  return null;
}

async function parseBody(req: IncomingMessage, schema: z.ZodType): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new ApiError(413, "request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw.length > 0 ? raw : "null");
  } catch {
    throw new ApiError(400, "request body is not valid JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(400, z.prettifyError(parsed.error));
  return parsed.data;
}