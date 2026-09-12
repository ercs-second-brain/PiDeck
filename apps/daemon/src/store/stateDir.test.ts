import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDir } from "./stateDir.js";

describe("resolveStateDir", () => {
  it("honours PD_HOME", () => {
    expect(resolveStateDir({ PD_HOME: "/tmp/pideck-state" })).toBe("/tmp/pideck-state");
  });

  it("defaults to ~/.pideck", () => {
    expect(resolveStateDir({})).toBe(join(homedir(), ".pideck"));
    expect(resolveStateDir({ PD_HOME: "  " })).toBe(join(homedir(), ".pideck"));
  });
});
