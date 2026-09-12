// @vitest-environment jsdom

/**
 * Component tests for <GlobalSettings />: the sub-nav, the General tab's
 * read-only facts and update check, the review account's replace/clear with
 * write-only token, and the four per-persona model selects. The API client
 * is mocked.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSettingsRead, PiProbe, Status } from "@pideck/shared";

vi.mock("./client", () => ({
  loadStatus: vi.fn(),
  loadGlobalSettings: vi.fn(),
  saveGlobalSettings: vi.fn(),
  loadPiProbe: vi.fn(),
  checkForUpdate: vi.fn(),
  checkForUpdateNow: vi.fn(),
  loadPrompt: vi.fn(),
  savePrompt: vi.fn(),
  resetPrompt: vi.fn(),
  loadProject: vi.fn(),
  loadProjectSettings: vi.fn(),
  saveProjectSettings: vi.fn(),
  deleteProject: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { GlobalSettings } from "./GlobalSettings";
import * as client from "./client";
import { api } from "../lib/api";
import { makeView } from "../logs/test-support";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocked = vi.mocked(client);

const STATUS: Status = {
  version: "1.2.0",
  stateDir: "/home/me/.local/share/pideck",
  pollIntervalSeconds: 30,
  piReady: true,
  ghReady: true,
  github: { throttledUntil: null, lastError: null },
};

const SETTINGS: GlobalSettingsRead = {
  reviewAccount: { username: "reviewer-bot", tokenSet: true },
  modelByPersona: { global: null, orchestrator: null, worker: null, reviewer: null },
};

const NO_ACCOUNT: GlobalSettingsRead = {
  reviewAccount: null,
  modelByPersona: { global: null, orchestrator: null, worker: null, reviewer: null },
};

const PROBE: PiProbe = {
  ok: true,
  detail: "",
  providers: [],
  models: ["claude-x", "glm-5"],
  defaultModel: "claude-x",
};

const roots: Root[] = [];

/** Endpoint → resolved value for the useUpdateApply hook's direct api calls. */
const apiResponses: Partial<Record<string, unknown>> = {};

function mount(element: React.ReactElement): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  roots.push(root);
  return { root, container };
}

async function flush() {
  await act(async () => {});
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

function setInputValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const proto =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function inputByType(container: HTMLElement, type: string): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(`input[type="${type}"]`);
  if (!element) throw new Error(`no ${type} input`);
  return element;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

describe("<GlobalSettings />", () => {
  beforeEach(() => {
    mocked.loadStatus.mockResolvedValue(STATUS);
    mocked.loadGlobalSettings.mockResolvedValue(SETTINGS);
    mocked.loadPiProbe.mockResolvedValue(PROBE);
    Object.assign(apiResponses, {
      status: STATUS,
      updateApply: { ok: true },
      sessionList: [],
    });
    vi.mocked(api).mockImplementation(((name: string) => {
      const value = apiResponses[name];
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value);
    }) as never);
  });

  it("shows the read-only daemon facts and the update check on General", async () => {
    mocked.checkForUpdateNow.mockResolvedValue({ updateAvailable: true, latestVersion: "1.3.0" });
    const { container } = mount(<GlobalSettings />);
    await flush();
    expect(container.textContent).toContain("30s");
    expect(container.textContent).toContain(STATUS.stateDir);
    expect(container.textContent).toContain("1.2.0");
    await act(async () => {
      buttonByText(container, "Check for updates").click();
    });
    await flush();
    expect(mocked.checkForUpdateNow).toHaveBeenCalled();
    expect(container.textContent).toContain("Update available (1.3.0)");
    expect(container.textContent).toContain("Checked");
  });

  it("labels a finished check as Checked, not Saved", async () => {
    mocked.checkForUpdateNow.mockResolvedValue({ updateAvailable: false, latestVersion: null });
    const { container } = mount(<GlobalSettings />);
    await flush();
    await act(async () => {
      buttonByText(container, "Check for updates").click();
    });
    await flush();
    expect(container.textContent).toContain("Up to date");
    expect(buttonByText(container, "Checked")).toBeTruthy();
    expect(container.textContent).not.toContain("Saved");
  });

  it("offers an inline update after a check and applies it through the shared path", async () => {
    mocked.checkForUpdateNow.mockResolvedValue({
      updateAvailable: true,
      latestVersion: "abc1234 · 2 h old",
    });
    const { container } = mount(<GlobalSettings />);
    await flush();
    await act(async () => {
      buttonByText(container, "Check for updates").click();
    });
    await flush();
    expect(container.textContent).toContain("Update available (abc1234 · 2 h old)");
    const updateNow = buttonByText(container, "Update now");
    expect(updateNow.disabled).toBe(false);
    await act(async () => {
      updateNow.click();
    });
    await flush();
    expect(api).toHaveBeenCalledWith("updateApply");
    expect(container.textContent).toContain("fetching, rebuilding and restarting…");
    expect(buttonByText(container, "Updating…").disabled).toBe(true);
  });

  it("disables the inline update while agents are live", async () => {
    mocked.checkForUpdateNow.mockResolvedValue({ updateAvailable: true, latestVersion: "abc1234" });
    apiResponses.sessionList = [makeView({ persona: "worker" })];
    const { container } = mount(<GlobalSettings />);
    await flush();
    await act(async () => {
      buttonByText(container, "Check for updates").click();
    });
    await flush();
    expect(buttonByText(container, "Update now").disabled).toBe(true);
    expect(container.textContent).toContain("agents are live");
  });

  it("replaces the review account with a new token and never displays the token", async () => {
    mocked.saveGlobalSettings.mockResolvedValue(SETTINGS);
    const { container } = mount(<GlobalSettings />);
    await flush();
    act(() => {
      buttonByText(container, "Review account").click();
    });
    await flush();
    const username = inputByType(container, "text");
    expect(username.value).toBe("reviewer-bot");
    const token = inputByType(container, "password");
    expect(token.value).toBe("");
    setInputValue(username, "reviewer-2");
    setInputValue(token, "gh-token");
    await act(async () => {
      buttonByText(container, "Save").click();
    });
    await flush();
    expect(mocked.saveGlobalSettings).toHaveBeenCalledWith({
      reviewAccount: { username: "reviewer-2", token: "gh-token" },
    });
    expect(inputByType(container, "password").value).toBe("");
  });

  it("keeps the stored token when the token field is left blank", async () => {
    mocked.saveGlobalSettings.mockResolvedValue(SETTINGS);
    const { container } = mount(<GlobalSettings />);
    await flush();
    act(() => {
      buttonByText(container, "Review account").click();
    });
    await flush();
    await act(async () => {
      buttonByText(container, "Save").click();
    });
    await flush();
    expect(mocked.saveGlobalSettings).toHaveBeenCalledWith({
      reviewAccount: { username: "reviewer-bot" },
    });
  });

  it("requires a token when none is set", async () => {
    mocked.loadGlobalSettings.mockResolvedValue(NO_ACCOUNT);
    const { container } = mount(<GlobalSettings />);
    await flush();
    act(() => {
      buttonByText(container, "Review account").click();
    });
    await flush();
    setInputValue(inputByType(container, "text"), "reviewer-2");
    await act(async () => {
      buttonByText(container, "Save").click();
    });
    await flush();
    expect(mocked.saveGlobalSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("A personal access token is required.");
  });

  it("requires a username", async () => {
    const { container } = mount(<GlobalSettings />);
    await flush();
    act(() => {
      buttonByText(container, "Review account").click();
    });
    await flush();
    setInputValue(inputByType(container, "text"), "");
    await act(async () => {
      buttonByText(container, "Save").click();
    });
    await flush();
    expect(mocked.saveGlobalSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Username is required.");
  });

  it("clears the review account", async () => {
    mocked.saveGlobalSettings.mockResolvedValue(NO_ACCOUNT);
    const { container } = mount(<GlobalSettings />);
    await flush();
    act(() => {
      buttonByText(container, "Review account").click();
    });
    await flush();
    await act(async () => {
      buttonByText(container, "Clear account").click();
    });
    await flush();
    expect(mocked.saveGlobalSettings).toHaveBeenCalledWith({ reviewAccount: null });
  });

  it("offers the pi models plus a pi default per persona and saves the choice", async () => {
    mocked.saveGlobalSettings.mockResolvedValue(SETTINGS);
    const { container } = mount(<GlobalSettings />);
    await flush();
    act(() => {
      buttonByText(container, "Models").click();
    });
    await flush();
    const selects = [...container.querySelectorAll("select")];
    expect(selects.length).toBe(4);
    for (const select of selects) {
      const labels = [...select.options].map((option) => option.textContent);
      expect(labels).toEqual(["pi default", "claude-x", "glm-5"]);
    }
    setInputValue(selects[1]!, "glm-5");
    await act(async () => {
      buttonByText(container, "Save").click();
    });
    await flush();
    expect(mocked.saveGlobalSettings).toHaveBeenCalledWith({
      modelByPersona: { global: null, orchestrator: "glm-5", worker: null, reviewer: null },
    });
  });
});