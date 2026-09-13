// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./Badge";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const roots: { root: Root; container: HTMLElement }[] = [];

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => root.render(element));
  return container;
}

afterEach(() => {
  for (const { root } of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

describe("<Badge />", () => {
  it("renders the full-text pill by default", () => {
    const container = mount(<Badge tone="green">ready</Badge>);
    const badge = container.querySelector(".badge--green")!;
    expect(badge.classList.contains("badge--dot")).toBe(false);
    expect(badge.textContent).toBe("ready");
  });

  it("renders a dot variant with the state label as title and aria-label", () => {
    const container = mount(<Badge tone="amber" dot>fixing</Badge>);
    const dot = container.querySelector(".badge--dot.badge--amber")!;
    expect(dot).not.toBeNull();
    expect(dot.textContent).toBe("");
    expect(dot.getAttribute("title")).toBe("fixing");
    expect(dot.getAttribute("aria-label")).toBe("fixing");
  });

  it("pulses only when asked", () => {
    const pulsing = mount(<Badge tone="blue" dot pulse>working</Badge>);
    expect(pulsing.querySelector(".badge--dot")!.classList.contains("badge--pulse")).toBe(true);
    const still = mount(<Badge tone="blue" dot>working</Badge>);
    expect(still.querySelector(".badge--dot")!.classList.contains("badge--pulse")).toBe(false);
  });
});