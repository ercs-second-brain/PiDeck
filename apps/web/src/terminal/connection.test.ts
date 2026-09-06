/**
 * Unit tests for the terminal connection's reconnect backoff.
 */

import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "./connection";

describe("backoffDelayMs", () => {
  it("doubles from 500ms", () => {
    expect(backoffDelayMs(1)).toBe(500);
    expect(backoffDelayMs(2)).toBe(1000);
    expect(backoffDelayMs(3)).toBe(2000);
    expect(backoffDelayMs(4)).toBe(4000);
  });

  it("caps at 8 seconds", () => {
    expect(backoffDelayMs(5)).toBe(8000);
    expect(backoffDelayMs(20)).toBe(8000);
  });

  it("treats non-positive attempts as the first attempt", () => {
    expect(backoffDelayMs(0)).toBe(500);
  });
});
