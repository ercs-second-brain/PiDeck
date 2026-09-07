import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { IssueCursor } from "./cursor.js";

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "agentskiss-cursor-")), "proj.json");
}

describe("IssueCursor", () => {
  it("starts with no cursor when no file exists (first-ever start)", () => {
    const cursor = new IssueCursor(tmpFile());
    expect(cursor.lastSeenIssueNumber).toBeNull();
  });

  it("persists on set and survives a reload (daemon restart)", () => {
    const file = tmpFile();
    new IssueCursor(file).set(46);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, lastSeenIssueNumber: 46 });
    expect(new IssueCursor(file).lastSeenIssueNumber).toBe(46);
  });

  it("only ever advances (set is monotonic)", () => {
    const file = tmpFile();
    const cursor = new IssueCursor(file);
    cursor.set(46);
    cursor.set(20);
    expect(cursor.lastSeenIssueNumber).toBe(46);
    cursor.set(47);
    expect(cursor.lastSeenIssueNumber).toBe(47);
    expect(new IssueCursor(file).lastSeenIssueNumber).toBe(47);
  });

  it("treats a corrupt file as no cursor and overwrites it on the next set", () => {
    const file = tmpFile();
    writeFileSync(file, "{not json", "utf8");
    const cursor = new IssueCursor(file);
    expect(cursor.lastSeenIssueNumber).toBeNull();
    cursor.set(5);
    expect(new IssueCursor(file).lastSeenIssueNumber).toBe(5);
  });
});
