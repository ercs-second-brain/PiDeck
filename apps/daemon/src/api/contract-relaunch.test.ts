/**
 * Contract tests for the session relaunch endpoint's orchestrator persona
 * relaunch (issue #290): relaunching an orchestrator session — project
 * orchestrator or the workspace-level global agent — must put pi back in
 * the pane with that role's persona, identical to a fresh orchestrator
 * boot (launch line with the role's rendered prompt file and the session
 * id env), instead of leaving a bare shell (bash finding B27). Worker
 * relaunch keeps its recorded-command resurrection (#117/#27) and is
 * covered in contract.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionSchema } from "@pideck/shared";

import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;
let daemon: ContractServer["daemon"];
let api: ContractServer["api"];

beforeAll(async () => {
  server = await startContractServer();
  daemon = server.daemon;
  api = server.api;
});

afterAll(async () => {
  await server?.close();
});

/** The single launch line typed into a freshly relaunched pane. */
function paneLaunchLine(tmuxSession: string): string {
  const pane = daemon.tmux.sessions.get(tmuxSession);
  expect(pane).toBeDefined();
  const lines = pane?.paneLines ?? [];
  expect(lines).toHaveLength(1); // exactly one typed line, and it is the launch
  return lines[0] ?? "";
}

describe("relaunchSession relaunches the orchestrator persona (issue #290)", () => {
  it("relaunches a project orchestrator with the orchestrator persona prompt", async () => {
    const res = await api("POST", "/api/projects", { mode: "clone", repoUrl: "https://github.com/o/r" });
    expect(res.status).toBe(200);
    const projectId = (res.json as { id: string }).id;

    const orchestrator = daemon.services.sessions.listSessions(projectId).find((s) => s.role === "orchestrator");
    expect(orchestrator).toBeDefined();

    const relaunch = await api("POST", `/api/sessions/${orchestrator?.id}/relaunch`);
    expect(relaunch.status).toBe(200);
    expect(sessionSchema.parse(relaunch.json).id).toBe(orchestrator?.id);

    // The pane is not a bare shell: pi relaunched with the orchestrator
    // persona file and its session id — identical to a fresh boot.
    const line = paneLaunchLine(orchestrator?.tmuxSession ?? "");
    expect(line).toContain("pi --append-system-prompt");
    expect(line).toContain("orchestrator-prompt.md");
    expect(line).toContain(`PD_SESSION_ID=${orchestrator?.id}`);
  });

  it("relaunches the workspace-level global agent with the global-agent persona prompt", async () => {
    const started = await api("POST", "/api/global-agent");
    expect(started.status).toBe(200);
    const globalAgent = sessionSchema.parse(started.json);
    expect(globalAgent.role).toBe("orchestrator");

    const relaunch = await api("POST", `/api/sessions/${globalAgent.id}/relaunch`);
    expect(relaunch.status).toBe(200);

    const line = paneLaunchLine(globalAgent.tmuxSession);
    expect(line).toContain("pi --append-system-prompt");
    expect(line).toContain("global-agent-prompt.md");
    expect(line).toContain(`PD_SESSION_ID=${globalAgent.id}`);
  });
});
