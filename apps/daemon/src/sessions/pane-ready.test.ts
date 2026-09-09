/**
 * Pane-input readiness probe (issue #318): the predicate and the bounded
 * wait. Live behavior (pi drops stdin typed during its startup window) is
 * pinned by the real-tmux integration test
 * (`agent-kind-spawn.integration.test.ts`); these units cover the probe's
 * decision table against a fake tmux server.
 */

import { describe, expect, it } from "vitest";
import { paneInputReady, waitForPaneInputReady } from "./pane-ready.js";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux } from "./tmux.js";

/** pi's input-box border at the fake's default 80 columns. */
const BORDER = "─".repeat(80);

function fakeTmux(): { tmux: Tmux; fake: FakeTmuxRunner } {
  const fake = new FakeTmuxRunner();
  return { tmux: new Tmux({ runner: (args) => fake.run(args) }), fake };
}

describe("paneInputReady", () => {
  it("is false for a bare shell pane (no pi chrome yet)", () => {
    expect(paneInputReady("$ ls\nsome output\n")).toBe(false);
    expect(paneInputReady("")).toBe(false);
  });

  it("is true once pi's input box is rendered", () => {
    expect(paneInputReady(`header\n${BORDER}\n\n${BORDER}\nfooter\n`)).toBe(true);
  });

  it("is true for the working-state bottom line (input stays accepting)", () => {
    expect(paneInputReady(`${"─".repeat(3)} ⠏ Working ${"─".repeat(60)}`)).toBe(true);
  });

  it("does not match short dashes (shell separators, markdown rules)", () => {
    expect(paneInputReady("---------\n")).toBe(false);
  });
});

describe("waitForPaneInputReady", () => {
  it("resolves true once the pane boots into pi", async () => {
    const { tmux, fake } = fakeTmux();
    await tmux.newSession("booting");
    // pi mounts after a short startup window (the #318 race window).
    setTimeout(() => {
      fake.sessions.get("booting")?.paneLines.push(BORDER);
    }, 60);
    expect(await waitForPaneInputReady(tmux, "booting", { timeoutMs: 2_000, pollIntervalMs: 20 })).toBe(true);
  });

  it("resolves false when the pane never shows the input box (timeout)", async () => {
    const { tmux } = fakeTmux();
    await tmux.newSession("shell-only");
    expect(await waitForPaneInputReady(tmux, "shell-only", { timeoutMs: 100, pollIntervalMs: 20 })).toBe(false);
  });

  it("resolves false when the pane dies mid-wait (tmux errors)", async () => {
    const { tmux } = fakeTmux();
    await tmux.newSession("dying");
    setTimeout(() => {
      void tmux.killSession("dying").catch(() => {});
    }, 30);
    expect(await waitForPaneInputReady(tmux, "dying", { timeoutMs: 2_000, pollIntervalMs: 20 })).toBe(false);
  });

  it("resolves true immediately for an already-ready pane (idempotent re-send)", async () => {
    const { tmux, fake } = fakeTmux();
    await tmux.newSession("ready");
    fake.sessions.get("ready")?.paneLines.push(BORDER);
    const started = Date.now();
    expect(await waitForPaneInputReady(tmux, "ready", { timeoutMs: 2_000, pollIntervalMs: 20 })).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
