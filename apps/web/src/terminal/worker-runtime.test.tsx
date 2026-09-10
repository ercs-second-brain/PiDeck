/**
 * Tests for the workers' running-time labels in the sidebar (issue #182):
 * live worker rows show a ticking duration since spawn; archived rows show
 * their final run duration frozen at the archive time. The row component is
 * pure, so it is exercised directly without xterm or effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { Worker } from "@pideck/shared";
import { WorkerRow } from "./picker-rows";
import { makeSession, makeWorker as makeWorkerFixture } from "./test-fixtures";

const started = "2026-01-01T00:00:00.000Z";

const session = makeSession({ id: "sess-worker-1", projectId: "proj", tmuxSession: "proj-worker-1", workerId: "worker-1", createdAt: started });

/** The #182 fixture: worker-1 tied to sess-worker-1, started at `started`. */
function makeWorker(status: Worker["status"], updatedAt = started): Worker {
  return makeWorkerFixture({ projectId: "proj", status, startedAt: started, updatedAt });
}

function renderRow(worker: Worker, overrides: Partial<Parameters<typeof WorkerRow>[0]> = {}): string {
  return renderToString(
    <WorkerRow
      session={session}
      workers={[worker]}
      archived={worker.status === "archived"}
      selectedSessionId={null}
      pending={false}
      now={Date.parse(started) + 42_000}
      onSelectSession={() => {}}
      onAskTerminate={() => {}}
      {...overrides}
    />,
  );
}

describe("worker running-time labels (issue #182)", () => {
  it("shows a live duration label since spawn on running rows", () => {
    const html = renderRow(makeWorker("running"));
    expect(html).toContain("picker-runtime");
    expect(html).toContain(">42s</span>");
  });

  it("freezes the final run duration at the archive time on archived rows", () => {
    const worker = makeWorker("archived", new Date(Date.parse(started) + 30 * 60_000).toISOString());
    const html = renderRow(worker);
    // Final span: 30m — independent of the ticking clock (now=42s).
    expect(html).toContain("picker-runtime-final");
    expect(html).toContain(">30m</span>");
    expect(html).not.toContain(">42s</span>");
  });

  it("omits the label when the row has no worker record", () => {
    const html = renderToString(
      <WorkerRow
        session={{ ...session, workerId: null }}
        workers={[]}
        archived={false}
        selectedSessionId={null}
        pending={false}
        onSelectSession={() => {}}
        onAskTerminate={() => {}}
      />,
    );
    expect(html).not.toContain("picker-runtime");
  });
});
