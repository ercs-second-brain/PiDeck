/**
 * The project row's ⋯ context menu (issue #167) and its spawn-agent submenu
 * (issue #331): Settings, "Spawn agent ▸" expanding to the built-in and
 * custom kind groups from the live registry (issue #330), and the
 * local-only delete entry (issue #172). Extracted from picker-rows to keep
 * each module under its complexity budget. Pure rendering.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { AGENT_KINDS, agentKindInfo, type AgentKind, type AgentKindSpec } from "@pideck/shared";

import { bestFlyoutPlacement } from "./flyout-flip";

/**
 * Callbacks shared by the project row and its open ⋯ menu (issues
 * #167/#172 + docs/agent-kinds.md, #297/#300/#302 + #324/#331): the
 * spawn-agent submenu entries render from the live kind registry — a
 * `waitForInput` kind opens the input modal, an `auto` kind spawns
 * directly.
 */
export interface ProjectMenuCallbacks {
  /** Opens the project's settings page in the main pane (issue #167). */
  onOpenSettings: (projectId: string) => void;
  /** Opens the delete-confirmation modal (issue #172). */
  onDeleteProject: (projectId: string) => void;
  /** Spawns an auto kind directly (docs/agent-kinds.md, #300/#302/#330). */
  onSpawnAgent: (projectId: string, kind: AgentKind) => void;
  /** Opens the input modal for a `waitForInput` kind (#297, #324, #331). */
  onAskSpawnInput: (projectId: string, kind: AgentKind) => void;
}

/**
 * The project row's open ⋯ context menu (issue #167): Settings, the
 * spawn-agent SUBMENU (issue #331 — a "Spawn agent" entry whose kinds
 * pop out as a flyout from the menu, issue #355), and the
 * local-only delete entry (issue #172). Pure rendering.
 */
export function ProjectMenu(props: {
  projectName: string;
  projectId: string;
  /** The kind registry the submenu renders from (issue #330). */
  agentKinds: readonly AgentKindSpec[];
  /** Whether the spawn-agent submenu is expanded (issue #331). */
  spawnSubmenuOpen: boolean;
  onToggleSpawnSubmenu: () => void;
  /** Hovering the submenu's parent item opens it (issue #448, B9); click stays the fallback. */
  onHoverSpawnSubmenu?: () => void;
} & ProjectMenuCallbacks) {
  return (
    <div className="picker-context-menu" role="menu" aria-label={`${props.projectName} options`}>
      <button
        type="button"
        role="menuitem"
        title={`Open ${props.projectName}'s settings`}
        onClick={() => props.onOpenSettings(props.projectId)}
      >
        Settings
      </button>
      {/* Issue #331 + #355 (B6): the spawn-agent submenu — closed by
          default; when expanded it pops OUT of the menu as a flyout
          anchored to its toggle (see .picker-submenu-anchor css). It stays
          a DOM child of the menu, so the outside-click dismiss still
          targets the whole menu. */}
      <div className="picker-submenu-anchor">
        <button
          type="button"
          role="menuitem"
          aria-haspopup="true"
          aria-expanded={props.spawnSubmenuOpen}
          title="Spawn an agent-kind session"
          onClick={props.onToggleSpawnSubmenu}
          onMouseEnter={props.onHoverSpawnSubmenu}
        >
          Spawn agent ▸
        </button>
        {props.spawnSubmenuOpen && (
          <SpawnAgentSubmenu
            projectId={props.projectId}
            agentKinds={props.agentKinds}
            onSpawnAgent={props.onSpawnAgent}
            onAskSpawnInput={props.onAskSpawnInput}
          />
        )}
      </div>
      {/* Issue #172: delete is local-only — the GitHub repo is kept; the
          confirmation modal states that explicitly. */}
      <button
        type="button"
        role="menuitem"
        className="picker-menu-danger"
        title={`Delete ${props.projectName} locally (the GitHub repo is kept)`}
        onClick={() => props.onDeleteProject(props.projectId)}
      >
        Delete project…
      </button>
    </div>
  );
}

/**
 * The spawn-agent submenu's flyout shell (issue #448, B8): after mount it
 * measures itself and its anchor (the `.picker-submenu-anchor` parent) and,
 * when the default left/top placement would overflow a screen edge, applies
 * the flip classes (`picker-submenu-flip-right` / `picker-submenu-flip-`
 * bottom`) that mirror the placement to the other side. The flyout is
 * remounted on every open, so each open re-probes the current viewport.
 */
function EdgeFlyout(props: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flips, setFlips] = useState<{ side: boolean; align: boolean }>({ side: false, align: false });
  useLayoutEffect(() => {
    const flyout = ref.current;
    const anchor = flyout?.parentElement;
    if (!flyout || !anchor) return;
    const placement = bestFlyoutPlacement(
      anchor.getBoundingClientRect(),
      { width: flyout.getBoundingClientRect().width, height: flyout.getBoundingClientRect().height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setFlips({ side: placement.side === "right", align: placement.align === "bottom" });
  }, []);
  const className =
    `picker-context-menu picker-submenu${flips.side ? " picker-submenu-flip-right" : ""}${flips.align ? " picker-submenu-flip-bottom" : ""}`;
  return (
    <div ref={ref} className={className} role="menu" aria-label="Spawn agent">
      {props.children}
    </div>
  );
}

/**
 * The spawn-agent submenu (issue #331): the live kind registry (issue #330)
 * grouped into built-ins and custom kinds. Entries are filtered by
 * `spawnableBy` — the project ⋯ menu spawns through the project context,
 * whose caller-of-record is the orchestrator (the #328 fallback parent),
 * so kinds the orchestrator may not spawn are hidden here (the daemon
 * remains the enforcement point, docs/agent-kinds.md §5). The kind's
 * `trigger` decides the click: `waitForInput` opens the input modal, `auto`
 * spawns immediately (its taskTemplate is the daemon's business, #329).
 * Pure rendering.
 */
function SpawnAgentSubmenu(props: {
  projectId: string;
  agentKinds: readonly AgentKindSpec[];
} & Pick<ProjectMenuCallbacks, "onSpawnAgent" | "onAskSpawnInput">) {
  const spawnable = props.agentKinds.filter((spec) => spec.spawnableBy.includes("orchestrator"));
  const builtIns = spawnable.filter((spec) => AGENT_KINDS.includes(spec.name));
  const custom = spawnable.filter((spec) => !AGENT_KINDS.includes(spec.name));
  const entry = (spec: AgentKindSpec) => {
    const fallback = agentKindInfo(spec.name);
    // Registry-v2 specs carry their own presentation fields — prefer them
    // (agentKindInfo's fallback only knows the shipped table).
    const menuLabel = spec.menuLabel ?? fallback.menuLabel;
    const description = spec.description ?? fallback.description;
    return (
      <button
        key={spec.name}
        type="button"
        role="menuitem"
        title={description}
        onClick={() =>
          spec.trigger === "waitForInput"
            ? props.onAskSpawnInput(props.projectId, spec.name)
            : props.onSpawnAgent(props.projectId, spec.name)
        }
      >
        {menuLabel}
      </button>
    );
  };
  const body = (
    <>
      <span className="picker-menu-label">Built-in</span>
      {builtIns.map(entry)}
      {custom.length > 0 && (
        <>
          <span className="picker-menu-label">Custom</span>
          {custom.map(entry)}
        </>
      )}
      {builtIns.length === 0 && custom.length === 0 && <span className="picker-menu-label">No spawnable kinds</span>}
    </>
  );
  return <EdgeFlyout>{body}</EdgeFlyout>;
}
