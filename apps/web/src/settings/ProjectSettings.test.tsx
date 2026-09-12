// @vitest-environment jsdom

/**
 * Component tests for <ProjectSettings />: the five loop knobs, save with
 * validation against the shared schema, and delete with confirm. The API
 * client is mocked; the components run for real.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings as ProjectSettingsData, Project } from "@pideck/shared";

vi.mock("./client", () => ({
  loadStatus: vi.fn(),
  loadGlobalSettings: vi.fn(),
  saveGlobalSettings: vi.fn(),
  loadPiProbe: vi.fn(),
  checkForUpdate: vi.fn(),
  loadPrompt: vi.fn(),
  savePrompt: vi.fn(),
  resetPrompt: vi.fn(),
  loadProject: vi.fn(),
  loadProjectSettings: vi.fn(),
  saveProjectSettings: vi.fn(),
  deleteProject: vi.fn(),
}));

import { ProjectSettings } from "./ProjectSettings";
import * as client from "./client";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocked = vi.mocked(client);

const SETTINGS: ProjectSettingsData = {
  workerConcurrency: 3,
  maxFixAttempts: 5,
  contextLimitPercent: 80,
  stallMinutes: 20,
  autoMerge: false,
};

const PROJECT: Project = {
  id: "my-api",
  name: "my-api",
  repoUrl: "https://github.com/acme/my-api",
  owner: "acme",
  repo: "my-api",
  defaultBranch: "main",
  path: "/home/me/my-api",
};

const roots: Root[] = [];

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

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.resetAllMocks();
});

describe("<ProjectSettings />", () => {
  beforeEach(() => {
    mocked.loadProject.mockResolvedValue(PROJECT);
    mocked.loadProjectSettings.mockResolvedValue(SETTINGS);
  });

  it("loads the project and its settings and renders the five knobs", async () => {
    const { container } = mount(<ProjectSettings projectId="my-api" />);
    await flush();
    expect(mocked.loadProjectSettings).toHaveBeenCalledWith("my-api");
    const numbers = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    expect(numbers.map((input) => input.value)).toEqual(["3", "5", "80", "20"]);
    const autoMerge = container.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(autoMerge?.checked).toBe(false);
    expect(container.textContent).toContain("Worker concurrency");
  });

  it("saves the parsed knobs", async () => {
    mocked.saveProjectSettings.mockResolvedValue(SETTINGS);
    const { container } = mount(<ProjectSettings projectId="my-api" />);
    await flush();
    const numbers = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    setInputValue(numbers[0]!, "4");
    await act(async () => {
      buttonByText(container, "Save").click();
    });
    await flush();
    expect(mocked.saveProjectSettings).toHaveBeenCalledWith("my-api", {
      workerConcurrency: 4,
      maxFixAttempts: 5,
      contextLimitPercent: 80,
      stallMinutes: 20,
      autoMerge: false,
    });
    expect(container.textContent).toContain("Saved");
  });

  it("rejects out-of-range values without calling the API", async () => {
    const { container } = mount(<ProjectSettings projectId="my-api" />);
    await flush();
    const numbers = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    setInputValue(numbers[2]!, "150");
    await act(async () => {
      buttonByText(container, "Save").click();
    });
    await flush();
    expect(mocked.saveProjectSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Too big");
  });

  it("toggles auto-merge", async () => {
    mocked.saveProjectSettings.mockResolvedValue(SETTINGS);
    const { container } = mount(<ProjectSettings projectId="my-api" />);
    await flush();
    const autoMerge = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    act(() => {
      autoMerge.click();
    });
    await act(async () => {
      buttonByText(container, "Save").click();
    });
    await flush();
    expect(mocked.saveProjectSettings).toHaveBeenCalledWith("my-api", {
      workerConcurrency: 3,
      maxFixAttempts: 5,
      contextLimitPercent: 80,
      stallMinutes: 20,
      autoMerge: true,
    });
  });

  it("deletes the project after naming it in a confirm dialog", async () => {
    mocked.deleteProject.mockResolvedValue({ ok: true });
    const { container } = mount(<ProjectSettings projectId="my-api" />);
    await flush();
    expect(container.textContent).not.toContain("Delete project my-api?");
    act(() => {
      buttonByText(container, "Delete project").click();
    });
    expect(container.textContent).toContain("Delete project my-api?");
    await act(async () => {
      buttonByText(container, "Delete").click();
    });
    await flush();
    expect(mocked.deleteProject).toHaveBeenCalledWith("my-api");
    expect(container.textContent).toContain("The project was deleted.");
  });
});