import { describe, expect, it } from "vitest";
import { clock, relativeTime } from "./relativeTime";

const NOW = Date.parse("2026-01-01T12:00:00Z");

describe("relativeTime", () => {
  it("renders recent, minute, hour and day scales", () => {
    expect(relativeTime("2026-01-01T11:59:50Z", NOW)).toBe("now");
    expect(relativeTime("2026-01-01T11:58:00Z", NOW)).toBe("2m");
    expect(relativeTime("2026-01-01T09:00:00Z", NOW)).toBe("3h");
    expect(relativeTime("2025-12-30T12:00:00Z", NOW)).toBe("2d");
  });

  it("clamps future timestamps to now and tolerates junk", () => {
    expect(relativeTime("2026-01-01T12:01:00Z", NOW)).toBe("now");
    expect(relativeTime("not a date", NOW)).toBe("");
    expect(relativeTime(null, NOW)).toBe("");
  });
});

describe("clock", () => {
  it("renders local wall-clock hh:mm", () => {
    expect(clock("2026-01-01T12:07:00Z")).toBe(
      new Date("2026-01-01T12:07:00Z").toTimeString().slice(0, 5),
    );
  });

  it("tolerates junk", () => {
    expect(clock("not a date")).toBe("");
  });
});
