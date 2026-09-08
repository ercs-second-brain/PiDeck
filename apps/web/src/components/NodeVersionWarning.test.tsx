/**
 * Tests for the node-too-old warning strip: the pure view is rendered
 * directly (same pattern as the toasts/update-banner tests); the fetching
 * wrapper is exercised through server rendering, which stays quiet until an
 * effect would populate it.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { NodeTooOldStrip, NodeVersionWarning } from "./NodeVersionWarning";

describe("NodeTooOldStrip", () => {
  it("renders an alert with the running node version and the fix", () => {
    const html = renderToString(<NodeTooOldStrip nodeVersion="v22.14.0" />);
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("v22.14.0");
    expect(html).toContain("pideck update");
  });
});

describe("NodeVersionWarning", () => {
  it("renders nothing until a status fetch resolves (server render: no effects)", () => {
    expect(renderToString(<NodeVersionWarning />)).toBe("");
  });
});
