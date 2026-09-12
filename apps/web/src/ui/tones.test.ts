import { describe, expect, it } from "vitest";
import { STATE_LABELS, STATE_TONES, stateBadge } from "./tones";

describe("worker state badge mapping", () => {
  it("maps every state to its DESIGN.md §3 colour", () => {
    expect(STATE_TONES.working).toBe("blue");
    expect(STATE_TONES.ci).toBe("amber");
    expect(STATE_TONES.fixing).toBe("amber");
    expect(STATE_TONES.in_review).toBe("purple");
    expect(STATE_TONES.addressing).toBe("amber");
    expect(STATE_TONES.ready).toBe("green");
    expect(STATE_TONES.blocked).toBe("red");
    expect(STATE_TONES.done).toBe("dim");
  });

  it("labels states exactly as the spec spells them", () => {
    expect(STATE_LABELS.in_review).toBe("in review");
    expect(STATE_LABELS.working).toBe("working");
    expect(STATE_LABELS.ci).toBe("ci");
    expect(STATE_LABELS.fixing).toBe("fixing");
    expect(STATE_LABELS.addressing).toBe("addressing");
    expect(STATE_LABELS.ready).toBe("ready");
    expect(STATE_LABELS.blocked).toBe("blocked");
    expect(STATE_LABELS.done).toBe("done");
  });

  it("stateBadge pairs tone and label", () => {
    expect(stateBadge("in_review")).toEqual({ tone: "purple", label: "in review" });
    expect(stateBadge("ready")).toEqual({ tone: "green", label: "ready" });
  });
});
