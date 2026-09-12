/**
 * The agent/README.md placeholder table must stay in lockstep with the
 * shared placeholder table — the doc and the daemon render from the same
 * contract, so a drift here means one of them is lying.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PromptPlaceholders } from "@pideck/shared";
import { agentDir } from "./shipped.js";

describe("agent/README.md placeholder table", () => {
  it("lists exactly the shared placeholders with the same descriptions", () => {
    const table = readFileSync(join(agentDir(), "README.md"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("| `{{"));
    expect(table).toHaveLength(PromptPlaceholders.length);

    for (const { token, description } of PromptPlaceholders) {
      const row = table.find((line) => line.includes(`\`{{${token}}}\``));
      expect(row, `README row for ${token}`).toBeDefined();
      expect(row!.replaceAll("`", "")).toContain(description);
    }
  });
});