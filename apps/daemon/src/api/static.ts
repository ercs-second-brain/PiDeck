import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

/**
 * Looks a request path up in the built web app directory. A missing
 * extension-less path falls back to index.html so the single-page app owns
 * its routing; anything else (missing files, unknown extensions, path
 * traversal) is left to the API's 404.
 */
export function lookupStaticFile(root: string, pathname: string): StaticFile | null {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  relative = relative.replace(/[?#].*$/, "").replace(/^\/+/, "");
  if (relative.includes("..")) return null;

  let target = relative === "" ? join(root, "index.html") : join(root, relative);
  if (isDirectory(target)) target = join(target, "index.html");
  if (!isFile(target)) {
    if (extname(relative) !== "" || relative === "") return null;
    target = join(root, "index.html");
  }
  const contentType = CONTENT_TYPES[extname(target)];
  if (!contentType) return null;
  try {
    return { body: readFileSync(target), contentType };
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}