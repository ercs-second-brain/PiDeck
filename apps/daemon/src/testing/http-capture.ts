/**
 * Fake `IncomingMessage`/`ServerResponse` pair for dispatching one request
 * through a `Router` without a real HTTP server (shared by router and
 * route-latency tests).
 */

export interface CapturedRequest {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  text: () => string;
  headers: Record<string, string | number | string[]>;
  status: () => number;
}

export function capture(method = "GET", url = "/api/projects", body?: string): CapturedRequest {
  const chunks: Buffer[] = [];
  const headers: Record<string, string | number | string[]> = {};
  let statusCode = 0;
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body);
    },
  } as unknown as import("node:http").IncomingMessage;
  const res = {
    set statusCode(value: number) {
      statusCode = value;
    },
    get statusCode() {
      return statusCode;
    },
    setHeader(key: string, value: string | number | string[]) {
      headers[key] = value;
    },
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
    },
  } as unknown as import("node:http").ServerResponse;
  return {
    req,
    res,
    text: () => Buffer.concat(chunks).toString("utf8"),
    headers,
    status: () => statusCode,
  };
}
