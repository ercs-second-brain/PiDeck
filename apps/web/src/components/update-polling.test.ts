/**
 * Tests for the update banner's WS-aware worker-gate refresher (issue
 * #451): worker lifecycle events are pushed over the kanban socket in real
 * time, and the banner's `activeWorkers` gate must not wait for the
 * 5-minute idle poll to notice them. The refresher debounces bursts into
 * one refetch; the gh check itself stays server-side cached.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatusResponse } from "@pideck/shared";
import { updateStatusResponseSchema } from "@pideck/shared";

import { boardStore } from "../store/store";
import { startWorkerGateRefresher } from "./update-polling";

vi.mock("../lib/api", () => ({
  apiGetUpdateStatus: vi.fn(),
}));

import { apiGetUpdateStatus } from "../lib/api";

const mockGetUpdateStatus = vi.mocked(apiGetUpdateStatus);

function status(): UpdateStatusResponse {
  return updateStatusResponseSchema.parse({
    repo: "o/r",
    ref: "main",
    localSha: "a".repeat(40),
    remoteSha: "b".repeat(40),
    runningSha: "a".repeat(40),
    runningBehindSource: false,
    applyProgress: null,
    updateAvailable: true,
    checkedAt: "2026-01-02T03:04:05.000Z",
    error: null,
    activeWorkers: 0,
    nodeVersion: "v22.23.2",
    nodeMinVersion: "22.19.0",
    nodeTooOld: false,
  });
}

/** A worker lifecycle event on the app-wide store (reducer may be a no-op). */
function workerEvent(status: "running" | "awaiting_ci"): void {
  boardStore.apply({
    type: "worker.status.changed",
    at: "2026-01-02T03:04:05.000Z",
    projectId: "push-test",
    workerId: "w-push-test",
    status,
  });
}

describe("startWorkerGateRefresher (issue #451)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("refetches the update status after a worker event, trailing-debounced", async () => {
    vi.useFakeTimers();
    const seen: UpdateStatusResponse[] = [];
    mockGetUpdateStatus.mockResolvedValue(status());
    const stop = startWorkerGateRefresher((result) => seen.push(result));

    workerEvent("running");
    expect(mockGetUpdateStatus).not.toHaveBeenCalled(); // debounce window
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mockGetUpdateStatus).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    stop();
  });

  it("collapses an event burst into one refetch", async () => {
    vi.useFakeTimers();
    mockGetUpdateStatus.mockResolvedValue(status());
    const stop = startWorkerGateRefresher(() => {});

    workerEvent("running");
    workerEvent("awaiting_ci");
    workerEvent("running");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mockGetUpdateStatus).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stays quiet without worker events, and a failed refetch is non-fatal", async () => {
    vi.useFakeTimers();
    const stop = startWorkerGateRefresher(() => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockGetUpdateStatus).not.toHaveBeenCalled();

    mockGetUpdateStatus.mockRejectedValue(new Error("daemon down"));
    workerEvent("running");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mockGetUpdateStatus).toHaveBeenCalledTimes(1); // rejection swallowed
    stop();
  });

  it("stops listening on cleanup", async () => {
    vi.useFakeTimers();
    const stop = startWorkerGateRefresher(() => {});
    stop();
    workerEvent("running");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mockGetUpdateStatus).not.toHaveBeenCalled();
  });
});
