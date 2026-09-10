import { describe, expect, it } from "vitest";
import {
  isTerminalUpdateStage,
  TERMINAL_UPDATE_STAGES,
  UPDATE_STAGE_TEXT,
} from "./update-stages.js";

describe("update-stages (issue #397)", () => {
  it("marks done/failed as the only terminal stages", () => {
    expect(isTerminalUpdateStage("done")).toBe(true);
    expect(isTerminalUpdateStage("failed")).toBe(true);
    expect(isTerminalUpdateStage("checking")).toBe(false);
    expect(isTerminalUpdateStage("fetching")).toBe(false);
    expect(isTerminalUpdateStage("building")).toBe(false);
    expect(isTerminalUpdateStage("installing")).toBe(false);
    expect(isTerminalUpdateStage("restarting")).toBe(false);
    expect(isTerminalUpdateStage("mystery")).toBe(false);
    expect(TERMINAL_UPDATE_STAGES.has("done") && TERMINAL_UPDATE_STAGES.has("failed")).toBe(true);
  });

  it("labels every non-terminal shim stage for the banner", () => {
    for (const stage of ["checking", "fetching", "building", "installing", "restarting"]) {
      expect(UPDATE_STAGE_TEXT[stage]).toBeTruthy();
      expect(isTerminalUpdateStage(stage)).toBe(false);
    }
    // Terminal stages stay out of the label map: the apply flow renders
    // completion/failure itself (UpdateApplyModal / error strips).
    expect(UPDATE_STAGE_TEXT.done).toBeUndefined();
    expect(UPDATE_STAGE_TEXT.failed).toBeUndefined();
  });
});