/**
 * BlockedTicketStore (issue #427): the persisted blocked-ticket map behind
 * the merge-driven unblock sweep. Same JsonStore pattern as the PR tracker
 * and the issue cursor — atomic writes, corrupt/missing file ⇒ empty map.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BlockedTicketStore } from "./blocked-store.js";
import { makeIssue } from "../../testing/fixtures.js";

const PROJECT_ID = "proj";

function tmpFile(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "pideck-blocked-store-")), "blocked.json");
}

function issue5(): ReturnType<typeof makeIssue> {
  return makeIssue(5, { blockers: [{ number: 2, state: "open", repository: null }] });
}

describe("BlockedTicketStore", () => {
  it("starts empty when no file exists", () => {
    const store = new BlockedTicketStore(tmpFile());
    expect(store.snapshot(PROJECT_ID)).toBeUndefined();
    expect(store.isRecorded(PROJECT_ID, 5)).toBe(false);
  });

  it("persists records and survives a reload (daemon restart)", () => {
    const file = tmpFile();
    const store = new BlockedTicketStore(file);
    store.record(issue5());
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      version: 1,
      projects: [{ projectId: PROJECT_ID, issues: [{ number: 5 }] }],
    });
    const reloaded = new BlockedTicketStore(file);
    expect(reloaded.isRecorded(PROJECT_ID, 5)).toBe(true);
    expect(reloaded.snapshot(PROJECT_ID)?.get(5)?.title).toBe(issue5().title);
  });

  it("removes records and drops empty projects from the file", () => {
    const file = tmpFile();
    const store = new BlockedTicketStore(file);
    store.record(issue5());
    store.remove(PROJECT_ID, 5);
    expect(store.snapshot(PROJECT_ID)).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, projects: [] });
    expect(new BlockedTicketStore(file).isRecorded(PROJECT_ID, 5)).toBe(false);
  });

  it("remove is a no-op for unknown projects/issues (no spurious write)", () => {
    const file = tmpFile();
    const store = new BlockedTicketStore(file);
    store.remove(PROJECT_ID, 5);
    expect(() => readFileSync(file, "utf8")).toThrow();
  });

  it("treats a corrupt file as an empty map and recovers on the next record", () => {
    const file = tmpFile();
    writeFileSync(file, "{not json", "utf8");
    const store = new BlockedTicketStore(file);
    expect(store.snapshot(PROJECT_ID)).toBeUndefined();
    store.record(issue5());
    expect(new BlockedTicketStore(file).isRecorded(PROJECT_ID, 5)).toBe(true);
  });

  it("groups records per project", () => {
    const store = new BlockedTicketStore(tmpFile());
    store.record(issue5());
    store.record({ ...issue5(), projectId: "other", number: 7 });
    expect(store.snapshot(PROJECT_ID)?.has(5)).toBe(true);
    expect(store.snapshot("other")?.has(5)).toBe(false);
    expect(store.snapshot("other")?.has(7)).toBe(true);
  });
});
