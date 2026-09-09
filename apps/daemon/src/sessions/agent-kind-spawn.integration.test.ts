/**
 * Integration test for the agent-kind spawn machinery against a real tmux
 * server (docs/agent-kinds.md, issues #297/#300/#302).
 *
 * The fake-tmux unit tests cover the mechanics; this proves the end-to-end
 * property on a real pty: an agent-kind session lands in a real tmux pane
 * running in the project clone (cheap kind), the persona file is written
 * next to the project state, the session id env is set, and the question is
 * deliverable into the pane. The pane payload is a raw-mode recorder (like
 * tmux-send.integration.test.ts) instead of pi, so no agent binary is
 * needed; the command-shape assertions cover the pi launch line.
 *
 * Skipped gracefully when tmux is unavailable; runs on a private socket.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentKindPromptFilePath } from "./agent-kinds.js";
import { ProjectLayout } from "./layout.js";
import { SessionManager } from "./manager.js";
import { SessionRegistry } from "./registry.js";
import { agentSessionEnv } from "./agent-env.js";
import { Tmux } from "./tmux.js";

const SOCKET = `pideck-kind-test-${process.pid}`;
const tmuxAvailable = await Tmux.isAvailable();

let stateDir = "";
let logFile = "";
let recorderScript = "";
let tmux: Tmux;
let manager: SessionManager;
let layout: ProjectLayout;
let registry: SessionRegistry;

const question = "why is spawn slow?";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  if (!tmuxAvailable) return;
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-kind-it-"));
  logFile = path.join(stateDir, "pane.log");
  // Raw-mode recorder as a script file (like tmux-send.integration.test.ts) —
  // inline `-e` code trips tmux's argv edge cases.
  writeFileSync(path.join(stateDir, "recorder.js"), [
    "const fs=require('fs');",
    `const log=${JSON.stringify(logFile)};`,
    "process.stdin.setRawMode(true);",
    "process.stdin.resume();",
    "process.stdin.on('data',(d)=>fs.appendFileSync(log,d));",
  ].join(""));
  recorderScript = path.join(stateDir, "recorder.js");
  // The daemon always injects the canonical runtime env (issue #253) — which
  // also wraps the pane command in the quoting-safe `sh -c 'exec "$@"'` form.
  tmux = new Tmux({ socketName: SOCKET, defaultSessionEnv: agentSessionEnv() });
  layout = new ProjectLayout(stateDir);
  registry = new SessionRegistry(layout.sessionsFilePath());
  manager = new SessionManager({ tmux, registry, layout });
});

afterAll(async () => {
  if (!tmuxAvailable) return;
  for (const session of registry.listSessions()) {
    await tmux.killSession(session.tmuxSession).catch(() => {});
  }
});

describe("agent-kind spawn on a real tmux server (docs/agent-kinds.md)", () => {
  it("lands the investigator in a real pane in the project clone, persona rendered, question deliverable", async () => {
    if (!tmuxAvailable) return;
    layout.ensureProject("proj");

    const session = await manager.spawnAgentKind("proj", {
      kind: "investigator",
      parentSessionId: "sess-caller-1",
      name: "inv",
      buildCommand: ({ sessionId, cwd }) => {
        // The api-layer flow: render the persona (with the parent lineage),
        // write it next to the project state, and build the launch command.
        const promptFile = agentKindPromptFilePath(layout, "proj", sessionId);
        mkdirSync(path.dirname(promptFile), { recursive: true });
        writeFileSync(promptFile, [
          "# Investigator",
          'pideck send --session sess-caller-1 --message "report"',
          `Path: ${cwd}`,
        ].join("\n"));
        return ["env", `PD_SESSION_ID=${sessionId}`, process.execPath, recorderScript];
      },
    });

    // The pane exists on the real server, in the project clone, recording.
    expect(await tmux.hasSession(session.tmuxSession)).toBe(true);
    await sleep(200);
    await tmux.sendKeys(session.tmuxSession, question, { enter: true });
    await sleep(200);
    expect(readFileSync(logFile, "utf8")).toContain(question);

    // The persona file sits next to the project state with the lineage rendered.
    const persona = readFileSync(
      agentKindPromptFilePath(layout, "proj", session.id),
      "utf8",
    );
    expect(persona).toContain("pideck send --session sess-caller-1");
    expect(persona).toContain(layout.cloneDir("proj"));
    expect(existsSync(path.join(layout.projectDir("proj"), "clone"))).toBe(true);

    // Relaunch re-creates a live pane from the recorded command.
    await manager.relaunchSession(session.id);
    expect(await tmux.hasSession(session.tmuxSession)).toBe(true);
  });
});
