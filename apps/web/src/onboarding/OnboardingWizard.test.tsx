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
import type { GlobalSettingsRead, PiProbe, Probe, Project, Status } from "@pideck/shared";
import { api } from "./api";
import { OnboardingWizard } from "./OnboardingWizard";

vi.mock("./api", () => ({
  api: {
    status: vi.fn(),
    probePi: vi.fn(),
    probeGhPrimary: vi.fn(),
    probeGhReview: vi.fn(),
    getGlobalSettings: vi.fn(),
    putGlobalSettings: vi.fn(),
    createProject: vi.fn(),
  },
}));

const piOk: PiProbe = { ok: true, detail: "", providers: ["anthropic", "github-copilot"], models: ["claude", "gpt"], defaultModel: "claude" };
const piFail: PiProbe = { ok: false, detail: "pi is not authenticated — run `pi auth` in a terminal", providers: [], models: [], defaultModel: null };
const ghOk: Probe = { ok: true, detail: "logged in as primary" };
const ghFail: Probe = { ok: false, detail: "gh is not authenticated — run `gh auth login`" };
const reviewOk: Probe = { ok: true, detail: "verified" };
const reviewFail: Probe = { ok: false, detail: "bad credentials for reviewer account" };

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
  vi.mocked(api.status).mockResolvedValue(statusFresh);
  vi.mocked(api.getGlobalSettings).mockResolvedValue(settingsNone);
  vi.mocked(api.probePi).mockResolvedValue(piOk);
  vi.mocked(api.probeGhPrimary).mockResolvedValue(ghOk);
  vi.mocked(api.probeGhReview).mockResolvedValue(reviewOk);
  vi.mocked(api.putGlobalSettings).mockResolvedValue(settingsSet);
  vi.mocked(api.createProject).mockResolvedValue(project);
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
    expect(api.probeGhPrimary).toHaveBeenCalledTimes(1);
  });

  it("shows the probe's hand-off instructions and blocks Next when pi is not ready, until Re-check passes", async () => {
    vi.mocked(api.probePi).mockResolvedValue(piFail);
    const container = await mountWizard();
    expect(container.textContent).toContain("run `pi auth` in a terminal");
    expect(buttonByText(container, "Next").disabled).toBe(true);

    vi.mocked(api.probePi).mockResolvedValue(piOk);
    await click(container, "Re-check");
    expect(api.probePi).toHaveBeenCalledTimes(2);
    expect(buttonByText(container, "Next").disabled).toBe(false);
  });

  it("surfaces a failed probe call as an inline error", async () => {
    vi.mocked(api.probePi).mockRejectedValue(new Error("daemon unreachable"));
    const container = await mountWizard();
    expect(container.textContent).toContain("daemon unreachable");
    expect(buttonByText(container, "Next").disabled).toBe(true);
  });

  it("shows the hand-off instructions and blocks Next when the gh probe fails", async () => {
    vi.mocked(api.probeGhPrimary).mockResolvedValue(ghFail);
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
    expect(api.putGlobalSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Username is required");
    expect(container.textContent).toContain("A personal access token is required");
  });

  it("saves the review account, verifies via the probe, and never shows the token afterwards", async () => {
    const container = await mountWizard();
    await click(container, "Next");
    await click(container, "Next");
    await typeInto(container, "Username", "reviewer-bot");
    await typeInto(container, "Personal access token", "ghp_secret");
    await click(container, "Verify");
    expect(vi.mocked(api.putGlobalSettings).mock.calls[0]?.[0]).toEqual({
      reviewAccount: { username: "reviewer-bot", token: "ghp_secret" },
    });
    expect(api.probeGhReview).toHaveBeenCalledTimes(1);
    expect(buttonByText(container, "Next").disabled).toBe(false);
    expect(inputByLabel(container, "Personal access token").value).toBe("");
    expect(document.body.textContent).not.toContain("ghp_secret");
  });

  it("keeps Next disabled and shows the probe detail when review verification fails", async () => {
    vi.mocked(api.probeGhReview).mockResolvedValue(reviewFail);
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
    expect(api.createProject).toHaveBeenCalledWith({ mode: "clone", repoUrl: "https://github.com/owner/my-api" });
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
    expect(api.createProject).toHaveBeenLastCalledWith({ mode: "create", name: "my-web", private: true });

    await act(async () => {
      inputByLabel(container, "Private repository").click();
    });
    await click(container, "Add project");
    expect(api.createProject).toHaveBeenLastCalledWith({ mode: "create", name: "my-web", private: false });
  });

  it("skips completed steps when re-entered to add another project", async () => {
    vi.mocked(api.status).mockResolvedValue({ ...statusFresh, piReady: true, ghReady: true });
    vi.mocked(api.getGlobalSettings).mockResolvedValue(settingsSet);
    const container = await mountWizard();
    expect(api.probePi).not.toHaveBeenCalled();
    expect(api.probeGhPrimary).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe("Repo");
    expect(container.textContent).toContain("Project repository");
  });
});
