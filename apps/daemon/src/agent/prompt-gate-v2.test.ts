/**
 * Prompt-gate v2 (issue #333): the kind spec drives read/write and trigger
 * behavior — the gate reads the registry's spec, never a hardcoded kind
 * list. This file enumerates the FULL config permutation (readOnly ×
 * trigger × callerWaits, 8 cells) over the pure decisions:
 *
 * - `agentKindLaunchCommand` / `agentKindExcludedTools` — read-only kinds
 *   get the gated tool set (`--exclude-tools edit,write`, the #308
 *   behavior), read-write kinds the full set;
 * - `planAgentKindSpawn` — auto kinds deliver their taskTemplate, wait
 *   kinds sit ready or deliver the caller's input; callerWaits caller-routed
 *   kinds notify the calling pane.
 *
 * The HTTP-level behavior (actual pane bytes per permutation) lives in
 * `api/agent-kind-spawn-prompt-gate.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { AgentKindSpec } from "@pideck/shared";

import { agentKindExcludedTools, agentKindLaunchCommand } from "../sessions/agent-kinds.js";
import { callerWaitsNotice, planAgentKindSpawn } from "./prompt-gate.js";

/** One full kind-spec config; every field is the permutation's variable. */
function specConfig(config: Partial<AgentKindSpec> & Pick<AgentKindSpec, "readOnly" | "trigger" | "callerWaits">): AgentKindSpec {
  return {
    name: "probe",
    label: "probe",
    persona: "You are the probe.",
    spawnableBy: ["orchestrator"],
    reportTarget: "caller",
    workerLike: false,
    ...config,
  } as AgentKindSpec;
}

describe("prompt-gate v2: kind-spec permutation matrix (issue #333)", () => {
  // 2 (readOnly) × 2 (trigger) × 2 (callerWaits) — every cell asserted.
  for (const readOnly of [true, false]) {
    for (const trigger of ["auto", "waitForInput"] as const) {
      for (const callerWaits of [true, false]) {
        const cell = `readOnly=${readOnly} trigger=${trigger} callerWaits=${callerWaits}`;
        const spec = specConfig({
          readOnly,
          trigger,
          callerWaits,
          ...(trigger === "auto" ? { taskTemplate: "Do the probe pass for {{PROJECT_NAME}}." } : {}),
          ...(callerWaits ? { reportTarget: "caller" as const } : {}),
        });

        it(`${cell}: tool gating follows the spec's readOnly flag`, () => {
          expect(agentKindExcludedTools(spec)).toEqual(readOnly ? ["edit", "write"] : []);
          const argv = agentKindLaunchCommand({ sessionId: "s1", promptFile: "/tmp/p.md", spec });
          const joined = argv.join(" ");
          expect(joined).toContain("pi --no-skills --append-system-prompt /tmp/p.md");
          expect(joined.includes("--exclude-tools edit,write")).toBe(readOnly);
        });

        it(`${cell}: delivery follows the spec's trigger`, () => {
          const withInput = planAgentKindSpawn(spec, "probe question");
          const withoutInput = planAgentKindSpawn(spec, undefined);
          if (trigger === "auto") {
            // Auto kinds take no caller input — the route's 409 guard owns
            // that; the planner delivers the taskTemplate either way.
            expect(withInput.delivery).toEqual({ kind: "task", text: spec.taskTemplate });
            expect(withoutInput.delivery).toEqual({ kind: "task", text: spec.taskTemplate });
          } else {
            expect(withInput.delivery).toEqual({ kind: "caller-input", text: "probe question" });
            expect(withoutInput.delivery).toEqual({ kind: "none" }); // sits ready
          }
        });

        it(`${cell}: caller-completion notice follows the spec's callerWaits`, () => {
          const plan = planAgentKindSpawn(spec, undefined);
          expect(plan.notifyCaller).toBe(callerWaits);
          if (callerWaits) {
            expect(callerWaitsNotice(spec, "probe-1")).toContain('probe agent "probe-1" is working');
            expect(callerWaitsNotice(spec, "probe-1")).toContain("deliver its report to this session");
          }
        });
      }
    }
  }

  it("an orchestrator-routed kind never notifies the caller, even when callerWaits", () => {
    // callerWaits only pairs with caller routing meaningfully: an
    // orchestrator-routed kind reports elsewhere, so there is nothing for
    // the caller to wait for (the daemon no-ops the notice).
    const spec = specConfig({ callerWaits: true, readOnly: true, reportTarget: "orchestrator", trigger: "auto", taskTemplate: "t" });
    expect(planAgentKindSpawn(spec, undefined).notifyCaller).toBe(false);
  });
});
