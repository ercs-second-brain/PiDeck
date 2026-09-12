// @vitest-environment jsdom

/**
 * Component tests for the header update pill: hidden without an update,
 * disabled with a hint while agents are live, apply → poll /api/status →
 * reload on a new version, and the recovery hint when the daemon stays
 * down. The API client is a mock.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestEndpointName, Status } from "@pideck/shared";
import { api } from "../lib/api";
import { makeView } from "../logs/test-support";
import { UpdateBanner } from "./UpdateBanner";

vi.mock("../lib/api", () => ({ api: vi.fn() }));

const statusOld: Status = {
  version: "0.1.0",
  stateDir: "/state",
  pollIntervalSeconds: 30,
  piReady: true,
  ghReady: true,
  github: { throttledUntil: null, lastError: null },
};
const statusNew: Status = { ...statusOld, version: "0.2.0" };

const updateAvailable = { updateAvailable: true, latestVersion: "abc1234" };
const noUpdate = { updateAvailable: false, latestVersion: null };

/** Endpoint → resolved value; an Error entry makes the call reject. */
const responses: Partial<Record<RestEndpointName, unknown>> = {};

let host: { root: Root; container: HTMLElement } | null = null;
let reload: ReturnType<typeof vi.fn>;

async function mountBanner(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  host = { root, container };
  await act(async () => {
    root.render(<UpdateBanner />);
  });
  await act(async () => {});
  return container;
}

async function click(container: HTMLElement, text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!button) throw new Error(`no button "${text}"`);
  await act(async () => {
    button.click();
  });
}

function pill(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button.update__pill");
  if (!(button instanceof HTMLButtonElement)) throw new Error("no update pill");
  return button;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    value: { ...window.location, reload },
    writable: true,
  });
  Object.assign(responses, {
    updateCheck: updateAvailable,
    updateCheckNow: updateAvailable,
    sessionList: [],
    status: statusOld,
    updateApply: { ok: true },
  });
  vi.mocked(api).mockImplementation(((name: RestEndpointName) => {
    const value = responses[name];
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  }) as never);
});

afterEach(() => {
  if (host) {
    act(() => host?.root.unmount());
    host.container.remove();
    host = null;
  }
  vi.useRealTimers();
});

describe("UpdateBanner", () => {
  it("renders nothing while no update is available", async () => {
    responses.updateCheck = noUpdate;
    const container = await mountBanner();
    expect(container.querySelector("button.update__pill")).toBeNull();
  });

  it("re-checks periodically and appears when a fresh check finds an update", async () => {
    responses.updateCheck = noUpdate;
    responses.updateCheckNow = noUpdate;
    const container = await mountBanner();
    expect(container.querySelector("button.update__pill")).toBeNull();

    responses.updateCheckNow = updateAvailable;
    await advance(10 * 60 * 1000);
    expect(container.querySelector("button.update__pill")).not.toBeNull();
    expect(api).toHaveBeenCalledWith("updateCheckNow");
  });

  it("disables the pill with a hint while a worker or reviewer is live", async () => {
    responses.sessionList = [makeView({ persona: "worker" })];
    const container = await mountBanner();
    const button = pill(container);
    expect(button.textContent).toBe("Update");
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("agents are live");

    // An orchestrator alone does not block; the pill re-enables on the poll.
    responses.sessionList = [makeView({ persona: "orchestrator" })];
    await advance(30_000);
    expect(button.disabled).toBe(false);
  });

  it("applies the update and reloads when the daemon returns with a new version", async () => {
    const container = await mountBanner();
    await click(container, "Update");
    expect(api).toHaveBeenCalledWith("updateApply");

    responses.status = statusNew;
    await advance(2_000);
    expect(reload).toHaveBeenCalled();
  });

  it("shows the recovery hint and a reload path when the daemon stays down", async () => {
    const container = await mountBanner();
    await click(container, "Update");
    responses.status = new Error("down");
    await advance(62_000);

    const button = pill(container);
    expect(button.textContent).toBe("Reload");
    expect(container.textContent).toContain("pideck logs");

    await click(container, "Reload");
    expect(reload).toHaveBeenCalled();
  });

  it("recovers when the daemon restarts without a version change", async () => {
    const container = await mountBanner();
    await click(container, "Update");
    await advance(92_000);

    const button = pill(container);
    expect(button.textContent).toBe("Reload");
    expect(container.textContent).toContain("old version");
  });
});
