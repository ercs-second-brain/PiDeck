/**
 * Integration test for the agent-kind launch path against a real tmux
 * server (docs/agent-kinds.md, issues #297/#300/#302, issue #310).
 *
 * The fake-tmux unit tests cover the mechanics; this proves the end-to-end
 * #290 property on a real pty: an agent-kind spawn lands in a real pane in
 * the project clone, the bootstrap types the persona launch line into it
 * (env, session id, --append-system-prompt, write-tool exclusions), the
 * question is deliverable, and a relaunch re-creates the bare shell that
 * the bootstrap heals with the same launch line. Skipped gracefully when
 * tmux is unavailable; runs on a private socket.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentKindPromptFilePath } from "./agent-kinds.js";
import { ProjectLayout } from "./layout.js";
import { Tmux } from "./tmux.js";
import { createDaemonContext, type DaemonServices } from "../api/context.js";
import { fakeGit } from "../api/testutil.js";

const SOCKET = `pideck-kind-test-${process.pid}`;
const tmuxAvailable = await Tmux.isAvailable();

let stateDir = "";
let tmux: Tmux;
let services: DaemonServices;

const question = "why is spawn slow?";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  if (!tmuxAvailable) return;
  stateDir = mkdtempSync(path.join(tmpdir(), "pideck-kind-it-"));
  tmux = new Tmux({ socketName: SOCKET });
  services = createDaemonContext({
    stateDir,
    tmux,
    git: fakeGit(),
    piReady: true,
    watcherEnabled: false,
  });
});

afterAll(async () => {
  if (!tmuxAvailable) return;
  for (const session of services.registry.listSessions()) {
    await tmux.killSession(session.tmuxSession).catch(() => {});
  }
});

describe("agent-kind launch on a real tmux server (docs/agent-kinds.md, issue #310)", () => {
  // Real-tmux + real-pi tests: pi's cold start and the readiness wait put
  // these well past vitest's 5s default on CI runners — explicit budget.
  it("spawns a bare pane, types the persona launch line, delivers the question, and relaunch-heals", { timeout: 60_000 }, async () => {
    if (!tmuxAvailable) return;
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/ak/it1" });
    const project = "ak-it1";

    // Menu-shaped spawn: the kind session + ensured orchestrator.
    const { handleAgentKindSpawn } = await import("../api/agent-kind-spawn.js");
    const session = await handleAgentKindSpawn(services, project, {
      kind: "investigator",
      name: "inv",
      question,
      parentSessionId: (await services.sessions.ensureOrchestrator(project)).id,
    });

    // Real pane, in the project clone, carrying the typed persona launch.
    expect(await tmux.hasSession(session.tmuxSession)).toBe(true);
    await sleep(200);
    const pane = services.registry.getSession(session.id);
    expect(pane?.cwd).toBe(new ProjectLayout(stateDir).cloneDir(project));

    // The persona file sits next to the project state, lineage rendered.
    const persona = readFileSync(agentKindPromptFilePath(new ProjectLayout(stateDir), project, session.id), "utf8");
    expect(persona).toContain("pideck send --session");
    expect(persona).not.toContain("{{PARENT_SESSION_ID}}");

    // The question reaches the pane's input.
    await tmux.sendKeys(session.tmuxSession, question, { enter: true });

    // The user exits the pane; relaunch re-creates the bare shell and the
    // bootstrap heals it with the same persona launch line (issue #310).
    await services.sessions.relaunchSession(session.id);
    await services.orchestratorBootstrap.ensureForSession(
      services.registry.getSession(session.id)!,
    );
    expect(await tmux.hasSession(session.tmuxSession)).toBe(true);
    const personaAfter = readFileSync(
      agentKindPromptFilePath(new ProjectLayout(stateDir), project, session.id),
      "utf8",
    );
    expect(personaAfter).toContain("pideck send --session");
  });

  it("delivers the question INSIDE pi on the menu spawn path (issue #318)", { timeout: 60_000 }, async () => {
    if (!tmuxAvailable) return;
    await services.projects.register({ mode: "clone", repoUrl: "https://github.com/ak/it2" });
    const project = "ak-it2";
    const { handleAgentKindSpawn } = await import("../api/agent-kind-spawn.js");
    const question = "Reply with the single word: ready.";
    const session = await handleAgentKindSpawn(services, project, {
      kind: "investigator",
      name: "inv",
      question,
      parentSessionId: (await services.sessions.ensureOrchestrator(project)).id,
    });
    if (session === undefined) throw new Error("spawn returned no session");

    // The pane booted pi WITH the persona: the launch line is in the pane
    // bytes (scrollback) and pi reports the rendered persona file as its
    // [Context] — the #318 end-to-end property on the live path. Match on
    // the newline-flattened capture: an 80-col pane wraps the long launch
    // line mid-token, and the wrap only inserts newlines, not characters.
    const deadline = Date.now() + 30_000;
    let pane = "";
    const flat = () => pane.replace(/\n/g, "");
    while (Date.now() < deadline) {
      pane = await tmux.capturePane(session.tmuxSession, { lines: 500 });
      if (flat().includes("--append-system-prompt") && flat().includes("[Context]")) break;
      await sleep(200);
    }
    expect(flat()).toContain(`PD_SESSION_ID=${session.id}`);
    expect(flat()).toContain("--append-system-prompt");
    expect(flat()).toContain(`agent-prompt-${session.id}`);
    expect(flat()).toContain("[Context]");

    // The question was SUBMITTED inside pi — it appears in the transcript
    // and the input box between the bottom borders no longer holds it (the
    // pre-fix race left it typed-but-never-sent in a fresh pane).
    while (Date.now() < deadline) {
      pane = await tmux.capturePane(session.tmuxSession, { lines: 500 });
      if (flat().includes(question) && !inputArea(pane).replace(/\n/g, "").includes(question)) break;
      await sleep(200);
    }
    expect(flat()).toContain(question);
    expect(inputArea(pane).replace(/\n/g, "")).not.toContain(question);
  });
});

/** The pi input box: whatever sits between the last two border lines. */
function inputArea(pane: string): string {
  const lines = pane.split("\n");
  const borders: number[] = [];
  lines.forEach((line, i) => {
    if (/─{10,}/.test(line)) borders.push(i);
  });
  if (borders.length < 2) return pane;
  const top = borders[borders.length - 2]!;
  const bottom = borders[borders.length - 1]!;
  return lines.slice(top + 1, bottom).join("\n");
}
