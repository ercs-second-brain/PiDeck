/**
 * Tests for the shared timestamp formatters: the compact card stamp
 * (formatTimestamp) and the human-scaled worker running-time label
 * (formatRunningDuration, issue #182).
 */

import { describe, expect, it } from "vitest";
import { formatRunningDuration, formatTimestamp } from "./format-timestamp";

describe("formatRunningDuration (issue #182)", () => {
  const started = "2026-01-01T00:00:00.000Z";
  const at = (ms: number) => Date.parse(started) + ms;

  it("shows seconds under a minute", () => {
    expect(formatRunningDuration(started, at(0))).toBe("0s");
    expect(formatRunningDuration(started, at(42_000))).toBe("42s");
    expect(formatRunningDuration(started, at(59_999))).toBe("59s");
  });

  it("shows minutes under an hour", () => {
    expect(formatRunningDuration(started, at(60_000))).toBe("1m");
    expect(formatRunningDuration(started, at(17 * 60_000))).toBe("17m");
    expect(formatRunningDuration(started, at(59 * 60_000 + 59_999))).toBe("59m");
  });

  it("shows hours under a day", () => {
    expect(formatRunningDuration(started, at(3 * 3_600_000))).toBe("3h");
    expect(formatRunningDuration(started, at(23 * 3_600_000 + 59 * 60_000))).toBe("23h");
  });

  it("shows days beyond a day", () => {
    expect(formatRunningDuration(started, at(24 * 3_600_000))).toBe("1d");
    expect(formatRunningDuration(started, at(50 * 3_600_000))).toBe("2d");
  });

  it("clamps future timestamps and empty-handles unparseable input", () => {
    expect(formatRunningDuration(started, Date.parse(started) - 30_000)).toBe("0s");
    expect(formatRunningDuration("not-a-date", at(0))).toBe("");
  });
});

describe("formatTimestamp", () => {
  it("formats a parseable date and falls back to the raw input otherwise", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatTimestamp("2026-01-01T00:00:00.000Z")).toMatch(/Jan/);
  });
});
