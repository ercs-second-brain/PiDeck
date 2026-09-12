// @vitest-environment jsdom

/**
 * Component tests for the <TracePanel />: the api client is mocked, so the
 * fetch → toggle → expand lifecycle runs for real in jsdom.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTrace } from "@pideck/shared";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: vi.fn(),
}));

const { TracePanel } = await import("./TracePanel");
const { api } = await import("../lib/api");

const apiMock = vi.mocked(api);

const trace: SessionTrace = {
  entries: [
    { at: new Date(Date.now() - 90 * 60 * 1000).toISOString(), kind: "spawn", detail: "spawned worker for issue #7" },
    { at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), kind: "facts", facts: { issueNumber: 7, prNumber: 11 } },
    { at: new Date().toISOString(), kind: "delivery", text: "CI failed: build" },
  ],
  transcriptPath: "/srv/pideck/pi-sessions/s1/pi.jsonl",
};

let host: { root: import("react-dom/client").Root; container: HTMLElement } | null = null;

function mount(sessionId: string): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  host = { root, container };
  act(() => {
    root.render(<TracePanel sessionId={sessionId} />);
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => {
  act(() => host?.root.unmount());
  host = null;
});

describe("TracePanel", () => {
  it("stays collapsed until toggled, then lists entries newest-first", async () => {
    apiMock.mockResolvedValue(trace);
    const container = mount("s1");
    await flush();

    expect(apiMock).toHaveBeenCalledWith("sessionTrace", { id: "s1" });
    expect(container.textContent).toContain("Trace (3)");
    expect(container.querySelector(".trace__list")).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>(".trace__toggle")!.click());
    await flush();

    const list = container.querySelector(".trace__list");
    expect(list).not.toBeNull();
    const kinds = [...list!.querySelectorAll(".trace__row .badge, .trace__row span")].map((el) => el.textContent);
    // Newest first: the delivery, then facts, then spawn.
    const badges = [...list!.querySelectorAll(".trace__row")].map((row) => row.textContent ?? "");
    expect(badges[0]).toContain("delivery");
    expect(badges[1]).toContain("facts");
    expect(badges[2]).toContain("spawn");
    expect(badges[2]).toContain("spawned worker for issue #7");
    expect(badges[1]).toContain("issue #7");
    void kinds;
  });

  it("expands a delivery to show the exact line sent to the pane", async () => {
    apiMock.mockResolvedValue(trace);
    const container = mount("s1");
    await flush();
    act(() => container.querySelector<HTMLButtonElement>(".trace__toggle")!.click());
    await flush();

    expect(container.querySelector(".trace__text")).toBeNull();
    const deliveryButton = [...container.querySelectorAll<HTMLButtonElement>("button.trace__summary")][0]!;
    expect(deliveryButton.textContent).toBe("CI failed: build");
    act(() => deliveryButton.click());
    await flush();

    const text = container.querySelector(".trace__text");
    expect(text?.textContent).toBe("CI failed: build");
  });

  it("opens the transcript view when the transcript exists and hides the toggle when it does not", async () => {
    const transcriptEntries = [
      { role: "user", at: "2026-01-01T00:00:01Z", text: "Run the shell command 'echo hi' and then stop." },
      { role: "tool", at: "2026-01-01T00:00:02Z", text: 'bash({"command": "echo hi"})' },
      { role: "assistant", at: "2026-01-01T00:00:03Z", text: "The command output `hi`" },
    ] as const;
    apiMock.mockImplementation(((name: string) =>
      name === "sessionTranscript"
        ? Promise.resolve({ entries: transcriptEntries })
        : Promise.resolve(trace)) as unknown as typeof api);
    const container = mount("s1");
    await flush();
    const button = container.querySelector<HTMLButtonElement>(".trace__transcript");
    expect(button).not.toBeNull();
    expect(container.querySelector("[data-testid=transcript-view]")).toBeNull();

    act(() => button!.click());
    await flush();

    const view = container.querySelector("[data-testid=transcript-view]");
    expect(view).not.toBeNull();
    expect(apiMock).toHaveBeenCalledWith("sessionTranscript", { id: "s1" });
    const badges = [...view!.querySelectorAll(".trace__row .badge")].map((el) => el.textContent);
    // Newest last: user first, then the tool call, then the assistant reply.
    expect(badges).toEqual(["user", "tool", "assistant"]);
    expect(view!.textContent).toContain("Run the shell command 'echo hi' and then stop.");
    expect(view!.textContent).toContain("bash(");

    apiMock.mockClear();
    act(() => button!.click());
    await flush();
    expect(container.querySelector("[data-testid=transcript-view]")).toBeNull();
  });

  it("shows a no-transcript-yet state when the session has no transcript entries", async () => {
    apiMock.mockImplementation(((name: string) =>
      name === "sessionTranscript" ? Promise.resolve({ entries: [] }) : Promise.resolve(trace)) as unknown as typeof api);
    const container = mount("s1");
    await flush();
    act(() => container.querySelector<HTMLButtonElement>(".trace__transcript")!.click());
    await flush();
    expect(container.querySelector("[data-testid=transcript-view]")!.textContent).toContain("No transcript yet.");
  });

  it("shows no transcript toggle when the trace has no transcript path", async () => {
    apiMock.mockResolvedValue({ entries: trace.entries, transcriptPath: null });
    const container = mount("s2");
    await flush();
    expect(container.querySelector(".trace__transcript")).toBeNull();
  });

  it("shows an empty list message for a session with nothing traced", async () => {
    apiMock.mockResolvedValue({ entries: [], transcriptPath: null });
    const container = mount("s1");
    await flush();
    act(() => container.querySelector<HTMLButtonElement>(".trace__toggle")!.click());
    await flush();
    expect(container.textContent).toContain("Nothing traced for this session yet.");
  });
});
