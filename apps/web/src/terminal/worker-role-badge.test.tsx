/**
 * Tests for the worker rows' role badge (issue #409, B31): a review agent
 * (Worker.kind === "reviewer", issue #107) badges "reviewer" instead of the
 * generic "worker" — mirroring how agent-kind rows badge the kind itself —
 * while implementer workers (explicit or the absent pre-#107 default) keep
 * "worker". Live and archived rows alike. The row component is pure, so it
 * is exercised directly without xterm or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Worker } from "@pideck/shared";
import { SessionPicker, type ProjectEntry } from "./SessionPicker";
import { WorkerRow } from "./picker-rows";
import { makeProject, makeSession, makeWorker } from "./test-fixtures";

const session = makeSession({ id: "sess-worker-1", workerId: "worker-1", tmuxSession: "pideck-agentskiss-worker-1" });

function renderRow(worker: Worker, overrides: Partial<Parameters<typeof WorkerRow>[0]> = {}): string {
  return renderToString(
    <WorkerRow
      session={session}
      workers={[worker]}
      archived={worker.status === "archived"}
      selectedSessionId={null}
      pending={false}
      onSelectSession={() => {}}
      onAskTerminate={() => {}}
      {...overrides}
    />,
  );
}

describe("worker role badges (issue #409, B31)", () => {
  it("badges a review agent 'reviewer' with the reviewer class", () => {
    const reviewer = makeWorker({ kind: "reviewer", parentWorkerId: "worker-0" });
    const html = renderRow(reviewer);
    expect(html).toContain("role-reviewer");
    expect(html).toContain(">reviewer</span>");
    expect(html).not.toContain(">worker</span>");
  });

  it("keeps the generic 'worker' badge for implementer workers", () => {
    const html = renderRow(makeWorker({ kind: "implementer" }));
    expect(html).toContain("role-worker");
    expect(html).toContain(">worker</span>");
    expect(html).not.toContain("role-reviewer");
  });

  it("keeps the generic 'worker' badge when the record omits kind (pre-#107 default)", () => {
    const html = renderRow(makeWorker());
    expect(html).toContain("role-worker");
    expect(html).toContain(">worker</span>");
  });

  it("badges archived review agents 'reviewer' too", () => {
    const reviewer = makeWorker({ kind: "reviewer", status: "archived" });
    const html = renderRow(reviewer);
    expect(html).toContain("role-reviewer");
    expect(html).toContain(">reviewer</span>");
  });

  it("shows the reviewer badge through the full picker render", () => {
    const project = makeProject();
    const orchestrator = makeSession({ id: "sess-orch-1", role: "orchestrator", tmuxSession: "pideck-agentskiss-orchestrator" });
    const reviewerSession = makeSession({ id: "sess-reviewer-1", workerId: "worker-rev-1", tmuxSession: "pideck-agentskiss-reviewer" });
    const entry: ProjectEntry = {
      project,
      sessions: [orchestrator, reviewerSession],
      workers: [makeWorker({ id: "worker-rev-1", sessionId: "sess-reviewer-1", kind: "reviewer", issueNumber: 0, prNumber: 12 })],
    };
    const html = renderToString(
      <SessionPicker
        entries={[entry]}
        error={null}
        selectedSessionId={null}
        onSelectSession={() => {}}
        onSelectProject={() => {}}
        onOpenSettings={() => {}}
        onSelectAllProjects={() => {}}
        onStartOnboarding={() => {}}
        onOpenGlobalSettings={() => {}}
        onStartOrchestrator={() => {}}
      />,
    );
    expect(html).toContain("role-reviewer");
    expect(html).toContain(">reviewer</span>");
    expect(html).not.toContain(">worker</span>");
  });
});
