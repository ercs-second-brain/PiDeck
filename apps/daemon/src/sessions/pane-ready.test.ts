/**
 * Pane-input readiness probe (issue #318): the predicate and the bounded
 * wait. Live behavior (pi drops stdin typed during its startup window) is
 * pinned by the real-tmux integration test
 * (`agent-kind-spawn.integration.test.ts`); these units cover the probe's
 * decision table against a fake tmux server.
 */

import { describe, expect, it } from "vitest";
import { confirmPaneSubmitted, paneInputArea, paneInputReady, paneSubmitted, waitForPaneInputReady } from "./pane-ready.js";
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

describe("paneSubmitted (submit-acceptance evidence, issue #318)", () => {
  it("accepts text visible in a composer-less pane (plain shell / echo)", () => {
    expect(paneInputArea("$ prompt\nhello there\n")).toBe("");
    expect(paneSubmitted("$ prompt\nhello there\n", "hello there")).toBe(true);
  });

  it("rejects a draft still rendered inside the input box (Enter swallowed)", () => {
    const pane = `header\n${BORDER}\nhello there\n${BORDER}\nfooter\n`;
    expect(paneSubmitted(pane, "hello there")).toBe(false);
  });

  it("accepts text that reached the transcript outside the composer", () => {
    const pane = `hello there\n${BORDER}\n\n${BORDER}\nfooter\n`;
    expect(paneSubmitted(pane, "hello there")).toBe(true);
  });

  it("rejects absent text", () => {
    expect(paneSubmitted(`${BORDER}\n\n${BORDER}\n`, "hello there")).toBe(false);
  });

  it("is newline-insensitive (80-col wrap mid-token)", () => {
    const pane = `PD_SESSION_ID=s\ness-1 pi\n${BORDER}\n\n${BORDER}\n`;
    expect(paneSubmitted(pane, "PD_SESSION_ID=sess-1")).toBe(true);
  });

  it("ignores SGR attributes interleaved by colored output (issue #443)", () => {
    // capture-pane -e captures keep colors: a colored transcript interleaves
    // resets between the rows of a wrapped prompt, which must not break the
    // flattened substring match.
    const pane = `\x1b[38;2;138;190;183mPD_SESSION_ID=s\x1b[0m\n\x1b[32mess-1 pi\x1b[0m\n${BORDER}\n\n${BORDER}\n`;
    expect(paneSubmitted(pane, "PD_SESSION_ID=sess-1")).toBe(true);
  });
});

describe("confirmPaneSubmitted (bounded Enter-only nudges, agent-orchestrator pattern)", () => {
  it("accepts immediately when the text already reached the transcript", async () => {
    const { tmux, fake } = fakeTmux();
    await tmux.newSession("done");
    fake.sessions.get("done")?.paneLines.push("hello there");
    expect(await confirmPaneSubmitted(tmux, "done", "hello there", { timeoutMs: 1_000 })).toBe(true);
  });

  it("re-sends bare Enters (never the text) while the draft sits unsubmitted, then gives up", async () => {
    const { tmux, fake } = fakeTmux();
    await tmux.newSession("stuck");
    // A composer draft that never leaves: text rendered between borders.
    fake.sessions.get("stuck")?.paneLines.push(BORDER, "hello there", BORDER);
    const started = Date.now();
    expect(
      await confirmPaneSubmitted(tmux, "stuck", "hello there", {
        timeoutMs: 1_000,
        pollIntervalMs: 50,
        nudgeIntervalMs: 200,
      }),
    ).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);

    // The prompt text was never re-typed; only bare Enter nudges went out.
    expect(fake.sentBytes("stuck").toString("utf8")).toBe("");
    const enters = fake.invocations.filter(
      (inv) => inv.args[0] === "send-keys" && inv.args.includes("Enter") && inv.args.includes("-t") && inv.args[inv.args.indexOf("-t") + 1] === "stuck",
    );
    expect(enters).toHaveLength(2);
  });

  it("resolves false fast when the pane dies mid-confirmation", async () => {
    const { tmux } = fakeTmux();
    await tmux.newSession("dead");
    await tmux.killSession("dead");
    expect(await confirmPaneSubmitted(tmux, "dead", "hello there", { timeoutMs: 1_000 })).toBe(false);
  });
});
