import { describe, expect, it } from "vitest";
import { KANBAN_COLUMNS } from "@agentskiss/shared";
import { COLUMN_LABELS } from "./kanban";

describe("COLUMN_LABELS", () => {
  it("labels every shared kanban column", () => {
    for (const column of KANBAN_COLUMNS) {
      expect(COLUMN_LABELS[column]).toBeTruthy();
    }
    expect(Object.keys(COLUMN_LABELS)).toHaveLength(KANBAN_COLUMNS.length);
  });
});
