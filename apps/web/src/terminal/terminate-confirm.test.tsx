/**
 * Tests for the terminate-confirm modal lifecycle (issue #268): a worker's
 * terminate confirmation used to stay open after a successful terminate —
 * the modal was fire-and-forget. The lifecycle now mirrors the
 * delete-confirmation modal (issue #172): pending while in flight, **closed
 * on success**, open with the daemon's error on failure.
 *
 * The lifecycle lives in the pure {@link runTerminateConfirm} runner (the
 * hook wires it to React state), so it is testable without a DOM renderer;
 * the modal's error rendering is exercised via SSR.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import { TerminateWorkerModal } from "./picker-modals";
import { runTerminateConfirm, routesThroughSessionTerminate } from "./use-picker-state";
import type { Session, Worker } from "@pideck/shared";

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runTerminateConfirm (issue #268)", () => {
  it("closes the modal after a successful terminate", async () => {
    const gate = deferred();
    const terminate = vi.fn(() => gate.promise);
    const hooks = { setPending: vi.fn(), setError: vi.fn(), close: vi.fn() };

    const run = runTerminateConfirm("worker-1", terminate, hooks);
    // Pending flips on while the request is in flight, the modal stays open.
    expect(terminate).toHaveBeenCalledWith("worker-1");
    expect(hooks.setPending).toHaveBeenLastCalledWith(true);
    expect(hooks.close).not.toHaveBeenCalled();

    gate.resolve();
    await run;

    expect(hooks.close).toHaveBeenCalledTimes(1);
    expect(hooks.setPending).toHaveBeenLastCalledWith(false);
    expect(hooks.setError).toHaveBeenCalledWith(null);
  });

  it("keeps the modal open with the daemon's error when the terminate fails", async () => {
    const hooks = { setPending: vi.fn(), setError: vi.fn(), close: vi.fn() };

    await runTerminateConfirm("worker-1", async () => {
      throw new Error("pane already dead");
    }, hooks);

    expect(hooks.close).not.toHaveBeenCalled();
    expect(hooks.setError).toHaveBeenCalledWith("pane already dead");
    expect(hooks.setPending).toHaveBeenLastCalledWith(false);
  });

  it("clears a previous error before the next attempt", async () => {
    const hooks = { setPending: vi.fn(), setError: vi.fn(), close: vi.fn() };
    await runTerminateConfirm("worker-1", async () => {
      throw new Error("first failure");
    }, hooks);
    expect(hooks.setError).toHaveBeenLastCalledWith("first failure");

    await runTerminateConfirm("worker-1", async () => {}, hooks);

    expect(hooks.setError).toHaveBeenLastCalledWith(null);
    expect(hooks.close).toHaveBeenCalledTimes(1);
  });

  it("dismisses a stale confirm with no worker (no request goes out)", async () => {
    const terminate = vi.fn(async () => {});
    const hooks = { setPending: vi.fn(), setError: vi.fn(), close: vi.fn() };

    await runTerminateConfirm(null, terminate, hooks);

    expect(terminate).not.toHaveBeenCalled();
    expect(hooks.close).toHaveBeenCalledTimes(1);
  });
});

describe("terminate routing: listing/registry agreement (issue #488)", () => {
  const workerSession = (workerId: string | null) =>
    ({ id: "sess-1", projectId: "proj", role: "worker", tmuxSession: "pideck-proj-worker-1", workerId, createdAt: "" }) as Session;
  const workerRecord = (id: string) =>
    ({
      id,
      projectId: "proj",
      sessionId: "sess-1",
      issueNumber: 1,
      prNumbers: [],
      status: "running",
      statusMessage: null,
      startedAt: "",
      updatedAt: "",
    }) as Worker;

  it("routes a known worker record through the worker-id path", () => {
    const session = workerSession("worker-1");
    expect(routesThroughSessionTerminate(session, [workerRecord("worker-1")])).toBe(false);
  });

  it("routes a dangling worker pointer (registry lost the record) through the session-id path", () => {
    // Issue #488: the sidebar lists the session, but the daemon's registry
    // no longer holds the worker — the worker-id terminate call 404s, the
    // #317 session route kills the pane instead.
    const session = workerSession("worker-gone");
    expect(routesThroughSessionTerminate(session, [workerRecord("worker-1")])).toBe(true);
    expect(routesThroughSessionTerminate(session, [])).toBe(true);
  });

  it("routes a worker-less row (workerId null) through the session-id path (#482 parity)", () => {
    expect(routesThroughSessionTerminate(workerSession(null), [workerRecord("worker-1")])).toBe(true);
  });

  it("keeps the worker path for an unresolved confirm target (stale modal dismisses)", () => {
    expect(routesThroughSessionTerminate(undefined, [])).toBe(false);
  });
});

describe("TerminateWorkerModal error surface (issue #268)", () => {
  it("renders a failed terminate's error inside the modal", () => {
    const html = renderToString(
      <TerminateWorkerModal
        sessionName="proj-worker-1"
        pending={false}
        error="project &quot;x&quot; has 1 active worker(s)"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("terminate-modal-error");
    expect(html).toContain("active worker(s)");
    // Not pending: the confirm button stays actionable for a retry.
    expect(html).toContain("Delete");
    expect(html).not.toContain("Deleting…");
  });

  it("tells the truth about a record-less (adopted orphan) worker's delete (issue #482)", () => {
    // The #317 kill path removes the session record — nothing is archived.
    const html = renderToString(
      <TerminateWorkerModal sessionName="pideck-agentskiss-worker-2" archived={false} pending={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("Delete worker?");
    expect(html).toContain("killed and removed");
    expect(html).not.toContain("archived");
  });
});
