/**
 * Node runtime vs pi's requirement (issue #202): the pure comparison behind
 * the `/api/status` nodeVersion/nodeTooOld fields and the daemon startup
 * warning. pi 0.75+ needs Node >= 22.19 (zstd support landed there); a
 * daemon on an older node spawns pi sessions that crash on first request
 * with `zlib.createZstdDecompress is not a function`.
 */
import { describe, expect, it } from "vitest";

import { PI_NODE_MIN_VERSION, nodeSupportsPi, parseNodeVersion } from "./node-version.js";

describe("parseNodeVersion", () => {
  it("parses `node -v` output (leading v)", () => {
    expect(parseNodeVersion("v22.14.0")).toEqual([22, 14, 0]);
  });

  it("parses bare versions", () => {
    expect(parseNodeVersion("22.23.2")).toEqual([22, 23, 2]);
  });

  it("returns null for garbage", () => {
    expect(parseNodeVersion("")).toBeNull();
    expect(parseNodeVersion("v22")).toBeNull();
    expect(parseNodeVersion("latest")).toBeNull();
  });
});

describe("nodeSupportsPi (issue #202)", () => {
  it("accepts the exact floor", () => {
    expect(nodeSupportsPi("v22.19.0")).toBe(true);
  });

  it("accepts newer node", () => {
    expect(nodeSupportsPi("v22.23.2")).toBe(true);
    expect(nodeSupportsPi("v24.0.0")).toBe(true);
  });

  it("rejects the pre-zstd private node pin (the live crash)", () => {
    expect(nodeSupportsPi("v22.14.0")).toBe(false);
  });

  it("compares minor and patch components, not strings", () => {
    expect(nodeSupportsPi("v22.19.0", "22.9.0")).toBe(true); // 19 > 9 lexicographically too, but numerically enforced
    expect(nodeSupportsPi("v22.9.0", "22.19.0")).toBe(false);
    expect(nodeSupportsPi("v22.18.99", "22.19.0")).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(nodeSupportsPi("")).toBe(false);
  });

  it("pins pi's package.json engines floor", () => {
    expect(PI_NODE_MIN_VERSION).toBe("22.19.0");
  });
});
