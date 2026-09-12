/**
 * Integration test against real tmux. Opt in with PIDECK_TMUX_INTEGRATION=1;
 * runs on a private socket so it never touches the user's sessions.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Tmux } from "./tmux.js";

const enabled = process.env.PIDECK_TMUX_INTEGRATION === "1";

describe.skipIf(!enabled)("Tmux against real tmux", () => {
  it("creates, sends, captures, and kills a session", async () => {
    const tmux = new Tmux({ socketName: `pideck-it-${randomUUID().slice(0, 8)}`, enterDelayMs: 100 });
    const name = `pideck-it-${randomUUID().slice(0, 8)}`;

    await tmux.create(name, { cwd: tmpWd(), command: ["sh"] });
    await expect(tmux.isAlive(name)).resolves.toBe(true);
    await expect(tmux.listSessions()).resolves.toContain(name);

    await tmux.sendLine(name, "echo pideck-integration-$((1+1))");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pane = await tmux.capturePane(name);
    expect(pane).toContain("pideck-integration-2");

    await tmux.kill(name);
    await expect(tmux.isAlive(name)).resolves.toBe(false);
  }, 15000);

  it("injects env into the pane", async () => {
    const tmux = new Tmux({ socketName: `pideck-it-${randomUUID().slice(0, 8)}`, enterDelayMs: 100 });
    const name = `pideck-it-${randomUUID().slice(0, 8)}`;
    await tmux.create(name, {
      cwd: tmpWd(),
      command: ["sh", "-c", "echo PD=$PD_SESSION_ID; sleep 60"],
      env: { PD_SESSION_ID: "env-probe" },
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pane = await tmux.capturePane(name);
    expect(pane).toContain("PD=env-probe");
    await tmux.kill(name);
  }, 15000);
});

function tmpWd(): string {
  return "/tmp";
}
