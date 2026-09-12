import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionSchema, type Session, type TraceEntry } from "@pideck/shared";
import type { ProjectFacts } from "./read.js";
import { compactFacts, piTranscriptPath, Trace, traceFile } from "./trace.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pideck-trace-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function session(overrides: Partial<Session> = {}): Session {
  return SessionSchema.parse({
    id: "s1",
    persona: "worker",
    projectId: "p1",
    issueNumber: 7,
    tmuxSession: "pideck-s1",
    spawnedAt: new Date().toISOString(),
    model: null,
    ...overrides,
  });
}

function stateEntries(entries: TraceEntry[]): { from: string | null; to: string | null; status: string }[] {
  return entries
    .filter((entry) => entry.kind === "state")
    .map((entry) => ({ from: entry.from ?? null, to: entry.to ?? null, status: entry.status ?? "" }));
}

function factEntries(entries: TraceEntry[]): TraceFactsShape[] {
  return entries.filter((entry) => entry.kind === "facts").map((entry) => entry.facts ?? {});
}

type TraceFactsShape = NonNullable<TraceEntry["facts"]>;

describe("Trace", () => {
  it("appends one JSONL line per entry and reads them back in order", () => {
    const trace = new Trace(stateDir);
    trace.append("s1", { at: "2026-01-01T00:00:00Z", kind: "spawn", detail: "spawned worker for issue #7" });
    trace.append("s1", {
      at: "2026-01-01T00:01:00Z",
      kind: "delivery",
      text: "fix CI on PR #11",
      watermark: { fixAttempts: 1 },
    });

    const lines = readFileSync(traceFile(stateDir, "s1"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "spawn" });

    const entries = trace.read("s1");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "spawn", detail: "spawned worker for issue #7" });
    expect(entries[1]).toMatchObject({ kind: "delivery", text: "fix CI on PR #11", watermark: { fixAttempts: 1 } });
  });

  it("reads a session with no trace file as empty", () => {
    expect(new Trace(stateDir).read("missing")).toEqual([]);
  });

  it("records state entries only when the derived state changes, carrying the previous state", () => {
    const trace = new Trace(stateDir);
    trace.recordDerived("s1", "working", "working on #7", null);
    trace.recordDerived("s1", "working", "working on #7", null);
    trace.recordDerived("s1", "fixing", "fixing CI on PR #11", null);

    expect(stateEntries(trace.read("s1"))).toEqual([
      { from: null, to: "working", status: "working on #7" },
      { from: "working", to: "fixing", status: "fixing CI on PR #11" },
    ]);
  });

  it("records facts entries only when the compact facts change", () => {
    const trace = new Trace(stateDir);
    const facts = { issueNumber: 7, openBlockers: 0, prNumber: 11, headSha: "sha-1", ci: "ok" };
    trace.recordDerived("s1", "working", "working on #7", facts);
    trace.recordDerived("s1", "working", "working on #7", { ...facts });
    trace.recordDerived("s1", "ci", "CI running for PR #11", { ...facts, ci: "pending" });

    const recorded = factEntries(trace.read("s1"));
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual(facts);
    expect(recorded[1]).toEqual({ ...facts, ci: "pending" });
  });

  it("records a baton entry on every PR hand-off, with the head SHA", () => {
    const trace = new Trace(stateDir);
    trace.recordDerived("s1", "working", "working on #7", null, {
      holder: "reviewer",
      prNumber: 11,
      headSha: "sha-1",
    });
    // Same baton, again: deduped.
    trace.recordDerived("s1", "working", "working on #7", null, {
      holder: "reviewer",
      prNumber: 11,
      headSha: "sha-1",
    });
    // The submission hands the baton back to the worker.
    trace.recordDerived("s1", "addressing", "addressing review on PR #11", null, {
      holder: "worker",
      prNumber: 11,
      headSha: "sha-1",
    });
    // The push re-arms the reviewer on the new head.
    trace.recordDerived("s1", "in_review", "awaiting review on PR #11", null, {
      holder: "reviewer",
      prNumber: 11,
      headSha: "sha-2",
    });

    const batons = trace
      .read("s1")
      .filter((entry) => entry.kind === "baton")
      .map((entry) => ({ detail: entry.detail, facts: entry.facts }));
    expect(batons).toEqual([
      { detail: "baton: worker → reviewer", facts: { prNumber: 11, headSha: "sha-1" } },
      { detail: "baton: reviewer → worker", facts: { prNumber: 11, headSha: "sha-1" } },
      { detail: "baton: worker → reviewer", facts: { prNumber: 11, headSha: "sha-2" } },
    ]);
  });

  it("never writes a line larger than 1 KB, truncating the text instead", () => {
    const trace = new Trace(stateDir);
    trace.append("s1", {
      at: "2026-01-01T00:00:00Z",
      kind: "delivery",
      text: "x".repeat(5000),
      watermark: { lastPromptedHeadSha: "sha" },
    });

    for (const line of readFileSync(traceFile(stateDir, "s1"), "utf8").trimEnd().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(1024);
    }
    const [entry] = trace.read("s1");
    expect(entry?.kind).toBe("delivery");
    expect(entry?.text?.endsWith("…")).toBe(true);
  });

  it("keeps other sessions' traces separate", () => {
    const trace = new Trace(stateDir);
    trace.append("s1", { at: "2026-01-01T00:00:00Z", kind: "spawn", detail: "one" });
    trace.append("s2", { at: "2026-01-01T00:00:00Z", kind: "spawn", detail: "two" });
    expect(trace.read("s1")).toHaveLength(1);
    expect(trace.read("s2")).toHaveLength(1);
  });
});

describe("piTranscriptPath", () => {
  it("returns the newest pi JSONL, or null when the session dir is gone", () => {
    const dir = join(stateDir, "pi-sessions", "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.jsonl"), "{}\n");
    writeFileSync(join(dir, "new.jsonl"), "{}\n");

    expect(piTranscriptPath(stateDir, "s1")?.endsWith("new.jsonl")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    expect(piTranscriptPath(stateDir, "s1")).toBeNull();
  });
});

describe("compactFacts", () => {
  const facts: ProjectFacts = {
    issues: [
      {
        number: 7,
        title: "Add rate limiting",
        url: "https://github.com/acme/my-api/issues/7",
        assignees: ["acme"],
        openBlockers: 1,
        comments: [{ id: 5, author: "acme", body: "BLOCKED: nothing", createdAt: "2026-01-01T00:00:00Z" }],
      },
    ],
    prs: [
      {
        number: 11,
        headBranch: "pideck/issue-7",
        headSha: "abc123def456",
        mergeable: "MERGEABLE",
        reviewDecision: "CHANGES_REQUESTED",
        ciStatus: "failed",
        failingChecks: ["lint"],
        green: false,
        issueNumber: 7,
        reviews: [],
        reviewComments: [],
        prComments: [],
      },
    ],
    primaryLogin: "acme",
  };

  it("summarises the session's issue and PR as compact facts, never bodies", () => {
    const compact = compactFacts(session(), facts);
    expect(compact).toEqual({
      issueNumber: 7,
      openBlockers: 1,
      prNumber: 11,
      headSha: "abc123def456",
      ci: "failed",
      failingChecks: ["lint"],
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
    });
    expect(JSON.stringify(compact)).not.toContain("BLOCKED");
    expect(JSON.stringify(compact)).not.toContain("rate limiting");
  });

  it("falls back to the PR on the session's issue branch and returns null without facts", () => {
    const withoutPrNumber = compactFacts(session({ prNumber: undefined }), facts);
    expect(withoutPrNumber?.prNumber).toBe(11);

    const empty: ProjectFacts = { issues: [], prs: [], primaryLogin: null };
    expect(compactFacts(session(), empty)).toBeNull();
    expect(compactFacts(session(), null)).toBeNull();
  });
});
