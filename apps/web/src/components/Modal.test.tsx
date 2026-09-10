// @vitest-environment jsdom
/**
 * Tests for the shared modal shell (issue #396, KISS audit F11): one
 * component renders the `.modal-overlay`/`.modal-card` chrome every web
 * modal used to hand-copy, and owns the dialog behaviors once — Esc-to-close,
 * backdrop click, the focus trap, and focus return on close. These need a
 * real DOM (focus + keyboard events), so unlike the repo's SSR tests this
 * file runs under jsdom and drives real events through `act`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";

import { Modal } from "./Modal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const containers: HTMLElement[] = [];

function render(ui: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  containers.push(container);
  roots.push(root);
  return container;
}

function press(key: string, target: Element): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  for (const container of containers) container.remove();
  containers.length = 0;
});

describe("Modal chrome + dismissal (issue #396)", () => {
  it("renders the shared chrome: overlay, card, close button, dialog semantics", () => {
    const container = render(
      <Modal label="Global settings" closeLabel="Close global settings" onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );
    const overlay = container.querySelector(".modal-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("role")).toBe("dialog");
    expect(overlay?.getAttribute("aria-modal")).toBe("true");
    expect(overlay?.getAttribute("aria-label")).toBe("Global settings");
    expect(container.querySelector(".modal-card")).not.toBeNull();
    const close = container.querySelector(".modal-close");
    expect(close?.getAttribute("aria-label")).toBe("Close global settings");
    expect(container.textContent).toContain("body");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    const container = render(
      <Modal label="Test" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    press("Escape", container.querySelector(".modal-close")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on Escape while canClose is false (a request is in flight)", () => {
    const onClose = vi.fn();
    const container = render(
      <Modal label="Test" canClose={false} onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    press("Escape", container.querySelector("p")!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a backdrop click but not on a click inside the card", () => {
    const onClose = vi.fn();
    const container = render(
      <Modal label="Test" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    const overlay = container.querySelector(".modal-overlay")!;
    act(() => {
      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const onClose2 = vi.fn();
    const container2 = render(
      <Modal label="Test" onClose={onClose2}>
        <p>body</p>
      </Modal>,
    );
    act(() => {
      container2.querySelector("p")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose2).not.toHaveBeenCalled();
  });

});

describe("Modal focus handling (issue #396)", () => {
  it("moves focus into the dialog on open and gives it back on close", () => {
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const container = render(
      <Modal label="Test" onClose={() => {}}>
        <p>body</p>
      </Modal>,
    );
    // Focus entered the dialog — its first focusable control (the close button).
    expect(document.activeElement).toBe(container.querySelector(".modal-close"));

    act(() => roots[0]!.unmount());
    roots.length = 0;
    containers.length = 0;
    // Focus returned to where the user was before the modal opened.
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("does not steal focus when it already sits inside (an autoFocus field)", () => {
    const container = render(
      <Modal label="Test" onClose={() => {}}>
        <textarea autoFocus aria-label="question" />
      </Modal>,
    );
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });

  it("traps Tab: forward from the last control wraps to the first, backward from the first to the last", () => {
    const container = render(
      <Modal label="Test" onClose={() => {}}>
        <button type="button">first</button>
        <button type="button" className="last">
          last
        </button>
      </Modal>,
    );
    const close = container.querySelector<HTMLButtonElement>(".modal-close")!;
    const last = container.querySelector<HTMLButtonElement>(".last")!;
    // Focus order inside the dialog: close button, first, last.
    last.focus();
    press("Tab", last);
    expect(document.activeElement).toBe(close);
    press("Tab", close); // backward from the real first control wraps to the real last
    act(() => {
      close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it("closes only the innermost dialog on Escape (nested AssetDialog pattern)", () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const container = render(
      <Modal label="Outer" onClose={closeOuter}>
        <Modal label="Inner" onClose={closeInner}>
          <p>inner body</p>
        </Modal>
      </Modal>,
    );
    press("Escape", container.querySelector("p")!);
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it("renders status overlays: role=status, aria-live, no close button, no dialog semantics", () => {
    const container = render(
      <Modal status overlayClassName="update-modal-overlay" cardClassName="update-modal">
        <p>Updating…</p>
      </Modal>,
    );
    const overlay = container.querySelector(".modal-overlay.update-modal-overlay");
    expect(overlay?.getAttribute("role")).toBe("status");
    expect(overlay?.getAttribute("aria-live")).toBe("assertive");
    expect(overlay?.getAttribute("aria-label")).toBeNull();
    expect(container.querySelector(".modal-close")).toBeNull();
  });
});
