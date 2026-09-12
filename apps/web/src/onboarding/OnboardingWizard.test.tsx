// @vitest-environment jsdom

/**
 * Component tests for the onboarding wizard: the four steps, probe success and
 * failure paths, review-account save/verify semantics (the token must never be
 * rendered after saving), the repo step's clone|create bodies, and re-entry
 * that skips already-completed steps. The API client is a mock.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalSettingsRead, PiProbe, Probe, Project, RestEndpointName, ReviewLoginStart, ReviewLoginStatus, Status } from "@pideck/shared";
import { api } from "../lib/api";
import { OnboardingWizard } from "./OnboardingWizard";

vi.mock("../lib/api", () => ({ api: vi.fn() }));

const piOk: PiProbe = { ok: true, detail: "", providers: ["anthropic", "github-copilot"], models: ["claude", "gpt"], defaultModel: "claude" };
const piFail: PiProbe = { ok: false, detail: "pi is not authenticated — run `pi auth` in a terminal", providers: [], models: [], defaultModel: null };
const ghOk: Probe = { ok: true, detail: "logged in as primary" };
const ghFail: Probe = { ok: false, detail: "gh is not authenticated — run `gh auth login`" };
const reviewOk: Probe = { ok: true, detail: "logged in as reviewer-bot" };
const reviewFail: Probe = { ok: false, detail: "bad credentials for reviewer account" };

const reviewLoginPending: ReviewLoginStatus = { status: "pending", detail: null };
const reviewLoginDone: ReviewLoginStatus = { status: "done", detail: null };
const reviewLoginStart: ReviewLoginStart = { code: "ABCD-1234", url: "https://github.com/login/device" };

const settingsNone: GlobalSettingsRead = {
  reviewAccount: null,
  modelByPersona: { global: null, orchestrator: null, worker: null, reviewer: null },
};
const settingsSet: GlobalSettingsRead = {
  reviewAccount: { username: "reviewer-bot", tokenSet: true },
  modelByPersona: { global: null, orchestrator: null, worker: null, reviewer: null },
};

const statusFresh: Status = {
  version: "0.0.0",
  stateDir: "/state",
  pollIntervalSeconds: 30,
  piReady: false,
  ghReady: false,
  github: { throttledUntil: null, lastError: null },
};

const project: Project = {
  id: "p1",
  name: "my-api",
  repoUrl: "https://github.com/owner/my-api",
  owner: "owner",
  repo: "my-api",
  defaultBranch: "main",
  path: "/repos/my-api",
};

/** Endpoint → resolved value; an Error entry makes the call reject. */
const responses: Partial<Record<RestEndpointName, unknown>> = {};

function setInput(element: Element, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

let host: { root: Root; container: HTMLElement } | null = null;

async function mountWizard(onDone: (project: Project) => void = vi.fn()): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  host = { root, container };
  await act(async () => {
    root.render(<OnboardingWizard onDone={onDone} />);
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
  await act(async () => {});
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const input = container.querySelector(`input[aria-label="${label}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input "${label}"`);
  return input;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
}

async function typeInto(container: HTMLElement, label: string, value: string): Promise<void> {
  await act(async () => {
    setInput(inputByLabel(container, label), value);
  });
}

/** Walks pi → GitHub → review (verified) → repo so the repo step is on screen. */
async function reachRepoStep(container: HTMLElement): Promise<void> {
  await click(container, "Next");
  await click(container, "Next");
  await typeInto(container, "Username", "reviewer-bot");
  await typeInto(container, "Personal access token", "ghp_secret");
  await click(container, "Verify");
  await click(container, "Next");
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(responses, {
    status: statusFresh,
    globalSettingsGet: settingsNone,
    probePi: piOk,
    probeGhPrimary: ghOk,
    probeGhReview: reviewOk,
    reviewLoginStart: reviewLoginStart,
    reviewLoginStatus: reviewLoginPending,
    globalSettingsPut: settingsSet,
    projectCreate: project,
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
});

describe("OnboardingWizard", () => {
  it("renders the four step chips with pi first", async () => {
    const container = await mountWizard();
    const chips = [...container.querySelectorAll("span")].map((chip) => chip.textContent);
    expect(chips).toContain("pi");
    expect(chips).toContain("GitHub");
    expect(chips).toContain("Review account");
    expect(chips).toContain("Repo");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("pi");
  });

  it("shows providers and default model when the pi probe passes, then moves on", async () => {
    const container = await mountWizard();
    expect(container.textContent).toContain("Providers: anthropic, github-copilot");
    expect(container.textContent).toContain("Default model: claude");
    expect(buttonByText(container, "Next").disabled).toBe(false);
    await click(container, "Next");
    expect(container.textContent).toContain("GitHub CLI");
    expect(api).toHaveBeenCalledWith("probeGhPrimary");
  });

  it("shows the probe's hand-off instructions and blocks Next when pi is not ready, until Re-check passes", async () => {
    responses.probePi = piFail;
    const container = await mountWizard();
    expect(container.textContent).toContain("run `pi auth` in a terminal");
    expect(buttonByText(container, "Next").disabled).toBe(true);

    responses.probePi = piOk;
    await click(container, "Re-check");
    const piCalls = vi.mocked(api).mock.calls.filter(([name]) => name === "probePi");
    expect(piCalls).toHaveLength(2);
    expect(buttonByText(container, "Next").disabled).toBe(false);
  });

  it("surfaces a failed probe call as an inline error", async () => {
    responses.probePi = new Error("daemon unreachable");
    const container = await mountWizard();
    expect(container.textContent).toContain("daemon unreachable");
    expect(buttonByText(container, "Next").disabled).toBe(true);
  });

  it("shows the hand-off instructions and blocks Next when the gh probe fails", async () => {
    responses.probeGhPrimary = ghFail;
    const container = await mountWizard();
    await click(container, "Next");
    expect(container.textContent).toContain("run `gh auth login`");
    expect(buttonByText(container, "Next").disabled).toBe(true);
  });

  it("requires username and token before saving the review account", async () => {
    const container = await mountWizard();
    await click(container, "Next");
    await click(container, "Next");
    await click(container, "Verify");
    expect(api).not.toHaveBeenCalledWith("globalSettingsPut", undefined, expect.anything());
    expect(container.textContent).toContain("Username is required");
    expect(container.textContent).toContain("A personal access token is required");
  });

  it("starts the device flow on entry and shows the code, link, copy button, and live status", async () => {
    const container = await mountWizard();
    await click(container, "Next");
    await click(container, "Next");
    expect(api).toHaveBeenCalledWith("reviewLoginStart");
    expect(container.textContent).toContain("ABCD-1234");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://github.com/login/device");
    expect(buttonByText(container, "Copy code")).toBeDefined();
    expect(container.textContent).toContain("Waiting for you to finish the sign-in");
  });

  it("copies the one-time code to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const container = await mountWizard();
    await click(container, "Next");
    await click(container, "Next");
    await click(container, "Copy code");
    expect(writeText).toHaveBeenCalledWith("ABCD-1234");
    expect(container.textContent).toContain("Copied");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  it("marks the step done and enables Next once the device sign-in completes", async () => {
    responses.reviewLoginStatus = reviewLoginDone;
    const container = await mountWizard();
    await click(container, "Next");
    await click(container, "Next");
    expect(api).toHaveBeenCalledWith("reviewLoginStatus");
    expect(api).toHaveBeenCalledWith("probeGhReview");
    expect(container.textContent).toContain("logged in as reviewer-bot");
    expect(buttonByText(container, "Next").disabled).toBe(false);
  });

  it("moves from pending to done on a status poll", async () => {
    vi.useFakeTimers();
    try {
      const container = await mountWizard();
      await click(container, "Next");
      await click(container, "Next");
      expect(container.textContent).toContain("Waiting for you to finish the sign-in");
      responses.reviewLoginStatus = reviewLoginDone;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(container.textContent).toContain("logged in as reviewer-bot");
      expect(buttonByText(container, "Next").disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a failed device flow with a retry and keeps the PAT fallback available", async () => {
    responses.reviewLoginStatus = { status: "failed", detail: "device sign-in timed out after 15 minutes" };
    const container = await mountWizard();
    await click(container, "Next");
    await click(container, "Next");
    expect(container.textContent).toContain("device sign-in timed out after 15 minutes");
    expect(buttonByText(container, "Next").disabled).toBe(true);

    const startsBefore = vi.mocked(api).mock.calls.filter(([name]) => name === "reviewLoginStart").length;
    await click(container, "Sign in as the reviewer");
    const startsAfter = vi.mocked(api).mock.calls.filter(([name]) => name === "reviewLoginStart");
    expect(startsAfter.length).toBeGreaterThan(startsBefore);
  });

  it("keeps the PAT form as a collapsed fallback that still saves and verifies", async () => {
    const container = await mountWizard();
    await click(container, "Next");
    await click(container, "Next");
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(container.textContent).toContain("Use a personal access token instead");
    await typeInto(container, "Username", "reviewer-bot");
    await typeInto(container, "Personal access token", "ghp_secret");
    await click(container, "Verify");
    expect(api).toHaveBeenCalledWith("globalSettingsPut", undefined, {
      reviewAccount: { username: "reviewer-bot", token: "ghp_secret" },
    });
    expect(buttonByText(container, "Next").disabled).toBe(false);
  });

  it("saves the review account, verifies via the probe, and never shows the token afterwards", async () => {
    const container = await mountWizard();
    await click(container, "Next");
    await click(container, "Next");
    await typeInto(container, "Username", "reviewer-bot");
    await typeInto(container, "Personal access token", "ghp_secret");
    await click(container, "Verify");
    expect(api).toHaveBeenCalledWith("globalSettingsPut", undefined, {
      reviewAccount: { username: "reviewer-bot", token: "ghp_secret" },
    });
    expect(api).toHaveBeenCalledWith("probeGhReview");
    expect(buttonByText(container, "Next").disabled).toBe(false);
    expect(inputByLabel(container, "Personal access token").value).toBe("");
    expect(document.body.textContent).not.toContain("ghp_secret");
  });

  it("keeps Next disabled and shows the probe detail when review verification fails", async () => {
    responses.probeGhReview = reviewFail;
    const container = await mountWizard();
    await click(container, "Next");
    await click(container, "Next");
    await typeInto(container, "Username", "reviewer-bot");
    await typeInto(container, "Personal access token", "ghp_secret");
    await click(container, "Verify");
    expect(container.textContent).toContain("bad credentials for reviewer account");
    expect(buttonByText(container, "Next").disabled).toBe(true);
    expect(inputByLabel(container, "Personal access token").value).toBe("");
    expect(inputByLabel(container, "Personal access token").placeholder).toBe("Saved — leave blank to keep it");
  });

  it("registers a project by cloning the given URL", async () => {
    const onDone = vi.fn();
    const container = await mountWizard(onDone);
    await reachRepoStep(container);
    await typeInto(container, "Repository URL", "https://github.com/owner/my-api");
    await click(container, "Add project");
    expect(api).toHaveBeenCalledWith("projectCreate", undefined, {
      mode: "clone",
      repoUrl: "https://github.com/owner/my-api",
    });
    expect(onDone).toHaveBeenCalledWith(project);
  });

  it("creates a new private repository by default, with the privacy toggle", async () => {
    const onDone = vi.fn();
    const container = await mountWizard(onDone);
    await reachRepoStep(container);
    await click(container, "Create new");
    await click(container, "Add project");
    expect(container.textContent).toContain("Repository name is required");

    await typeInto(container, "Repository name", "my-web");
    await click(container, "Add project");
    expect(api).toHaveBeenLastCalledWith("projectCreate", undefined, {
      mode: "create",
      name: "my-web",
      private: true,
    });

    await act(async () => {
      inputByLabel(container, "Private repository").click();
    });
    await click(container, "Add project");
    expect(api).toHaveBeenLastCalledWith("projectCreate", undefined, {
      mode: "create",
      name: "my-web",
      private: false,
    });
  });

  it("skips completed steps when re-entered to add another project", async () => {
    responses.status = { ...statusFresh, piReady: true, ghReady: true };
    responses.globalSettingsGet = settingsSet;
    const container = await mountWizard();
    expect(api).not.toHaveBeenCalledWith("probePi");
    expect(api).not.toHaveBeenCalledWith("probeGhPrimary");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("Repo");
    expect(container.textContent).toContain("Project repository");
  });
});
