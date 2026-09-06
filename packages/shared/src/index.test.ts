import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, placeholder } from "./index.js";

describe("shared placeholder", () => {
  it("identifies the package", () => {
    expect(PACKAGE_NAME).toBe("@agentskiss/shared");
  });

  it("returns the placeholder string", () => {
    expect(placeholder()).toContain("placeholder");
  });
});
