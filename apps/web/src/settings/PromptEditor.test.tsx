// @vitest-environment jsdom

/**
 * Component tests for <PromptEditor />: persona tabs, the draft textarea,
 * the Shipped/Edited indicator, save (override) and reset-to-default with
 * confirm, and the placeholder list. The API client is mocked.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Persona, Prompt } from "@pideck/shared";

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

import { PromptEditor } from "./PromptEditor";
import * as client from "./client";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocked = vi.mocked(client);

const PROMPTS: Record<Persona, Prompt> = {
  global: { persona: "global", prompt: "global prompt text", edited: false },
  orchestrator: { persona: "orchestrator", prompt: "orchestrator prompt text", edited: true },
  worker: { persona: "worker", prompt: "worker prompt text", edited: false },
  reviewer: { persona: "reviewer", prompt: "reviewer prompt text", edited: false },
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

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector("textarea");
  if (!element) throw new Error("no textarea");
  return element;
}

function setInputValue(element: HTMLTextAreaElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
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

describe("<PromptEditor />", () => {
  beforeEach(() => {
    mocked.loadPrompt.mockImplementation((persona) => Promise.resolve(PROMPTS[persona]));
  });

  it("loads the global prompt by default and marks it Shipped", async () => {
    const { container } = mount(<PromptEditor />);
    await flush();
    expect(mocked.loadPrompt).toHaveBeenCalledWith("global");
    expect(textarea(container).value).toBe("global prompt text");
    expect(container.textContent).toContain("Shipped");
  });

  it("marks an overridden prompt Edited", async () => {
    const { container } = mount(<PromptEditor />);
    await flush();
    act(() => {
      buttonByText(container, "Orchestrator").click();
    });
    await flush();
    expect(mocked.loadPrompt).toHaveBeenCalledWith("orchestrator");
    expect(textarea(container).value).toBe("orchestrator prompt text");
    expect(container.textContent).toContain("Edited");
  });

  it("saves an override", async () => {
    mocked.savePrompt.mockResolvedValue({
      persona: "global",
      prompt: "edited prompt text",
      edited: true,
    });
    const { container } = mount(<PromptEditor />);
    await flush();
    setInputValue(textarea(container), "edited prompt text");
    await act(async () => {
      buttonByText(container, "Save").click();
    });
    await flush();
    expect(mocked.savePrompt).toHaveBeenCalledWith("global", { prompt: "edited prompt text" });
    expect(container.textContent).toContain("Edited");
    expect(textarea(container).value).toBe("edited prompt text");
  });

  it("resets to the shipped prompt after confirming", async () => {
    mocked.resetPrompt.mockResolvedValue(PROMPTS.global!);
    const { container } = mount(<PromptEditor />);
    await flush();
    expect(container.textContent).not.toContain("Reset the Global prompt");
    act(() => {
      buttonByText(container, "Reset to default").click();
    });
    expect(container.textContent).toContain("Reset the Global prompt");
    await act(async () => {
      buttonByText(container, "Reset").click();
    });
    await flush();
    expect(mocked.resetPrompt).toHaveBeenCalledWith("global");
    expect(textarea(container).value).toBe("global prompt text");
    expect(container.textContent).toContain("Shipped");
  });

  it("shows the placeholder list beside the editor", async () => {
    const { container } = mount(<PromptEditor />);
    await flush();
    expect(container.textContent).toContain("Placeholders");
    expect(container.textContent).toContain("{{ISSUE_NUMBER}}");
    expect(container.textContent).toContain("{{ORCHESTRATOR_SESSION_ID}}");
  });

  it("disables Save while the draft is unchanged", async () => {
    const { container } = mount(<PromptEditor />);
    await flush();
    expect((buttonByText(container, "Save") as HTMLButtonElement).disabled).toBe(true);
    setInputValue(textarea(container), "changed");
    expect((buttonByText(container, "Save") as HTMLButtonElement).disabled).toBe(false);
  });
});