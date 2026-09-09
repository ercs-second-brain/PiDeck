/**
 * Agent-kind registry specs (docs/agent-kinds.md, issues #297/#329): the
 * auto-task column — autonomous kinds carry a taskTemplate that is typed
 * after the persona boot; the researcher is task-less by config (it waits
 * for its caller's question) and renders no task at all.
 */

import { describe, expect, it } from "vitest";

import { agentKindSpec, renderAgentKindTask } from "./agent-kinds.js";

describe("agent-kind auto-task specs (issue #329)", () => {
  it("gives the autonomous audit kinds a task template; the researcher is task-less by config", () => {
    expect(agentKindSpec("kiss-audit").taskTemplate).toBeDefined();
    expect(agentKindSpec("devex-audit").taskTemplate).toBeDefined();
    expect(agentKindSpec("researcher").taskTemplate).toBeUndefined();
  });

  it("renders the task with the persona's placeholder set (project + report target)", () => {
    const rendered = renderAgentKindTask(agentKindSpec("kiss-audit"), {
      PROJECT_PATH: "/state/projects/ak/clone",
      ORCHESTRATOR_SESSION_ID: "sess-orch-9",
    });
    expect(rendered).toContain("audit the project at /state/projects/ak/clone");
    expect(rendered).toContain("pideck send --session sess-orch-9");
    expect(rendered).not.toContain("{{");
  });

  it("renders nothing for task-less kinds — no auto-task is typed after the boot", () => {
    expect(renderAgentKindTask(agentKindSpec("researcher"), { PROJECT_PATH: "/x" })).toBeUndefined();
  });
});
