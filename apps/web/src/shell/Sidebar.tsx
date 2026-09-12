import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type { Project, SessionView } from "@pideck/shared";
import { api } from "../lib/api";
import { Badge } from "../ui/Badge";
import { Dialog } from "../ui/Dialog";
import { stateBadge } from "../ui/tones";
import { relativeTime } from "./relativeTime";
import { buildTree, githubLinks, rowText, sessionRow, type GithubLink, type ProjectNode } from "./tree";
import "./sidebar.css";

interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

type Pending =
  | { kind: "terminate"; id: string; title: string }
  | { kind: "deleteProject"; id: string; name: string };

interface Renaming {
  id: string;
  value: string;
}

export interface SidebarProps {
  projects: Project[];
  sessions: SessionView[];
  selectedId: string | null;
  onNavigate: (path: string) => void;
  onChanged: () => void;
  onToast: (message: string) => void;
}

function terminateTitle(view: SessionView): string {
  const session = view.session;
  if (session.persona === "worker" && session.issueNumber !== undefined) {
    return `Terminate the worker for #${session.issueNumber}?`;
  }
  if (session.persona === "reviewer" && session.prNumber !== undefined) {
    return `Terminate the reviewer for PR #${session.prNumber}?`;
  }
  return `Terminate ${rowText(view)}?`;
}

function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

const MENU_WIDTH = 168;

/** Popover menu opened from the ⋯ buttons; closes on outside click or Escape. */
function RowMenu({ menu, onClose }: { menu: OpenMenu; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const left = Math.max(8, Math.min(menu.x - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
  return (
    <>
      <div className="srow-menu-overlay" onClick={onClose} onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }} />
      <div className="srow-menu" role="menu" style={{ left, top: menu.y }}>
        {menu.items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={`srow-menu__item${item.danger === true ? " srow-menu__item--danger" : ""}`}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * The session sidebar: global agent row, per-project collapsible groups with
 * the orchestrator, workers with nested reviewers, and a collapsed Archived
 * group. Clicking a session attaches; ⋯ opens row actions (rename, GitHub
 * links, terminate with confirm); project ⋯ opens Settings / GitHub / Delete.
 */
export function Sidebar({ projects, sessions, selectedId, onNavigate, onChanged, onToast }: SidebarProps) {
  const tree = useMemo(() => buildTree(projects, sessions), [projects, sessions]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [archivedOpen, setArchivedOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const openMenu = (event: MouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.right, y: rect.bottom + 4, items });
  };

  const openGithub = (link: GithubLink) => window.open(link.url, "_blank", "noopener");

  const sessionMenu = (project: Project, view: SessionView): MenuItem[] => [
    {
      label: "Rename…",
      onSelect: () =>
        setRenaming({ id: view.session.id, value: view.session.label ?? view.title ?? "" }),
    },
    ...githubLinks(project, view).map((link) => ({ label: link.label, onSelect: () => openGithub(link) })),
    { label: "Terminate", danger: true, onSelect: () => setPending({ kind: "terminate", id: view.session.id, title: terminateTitle(view) }) },
  ];

  const projectMenu = (project: Project): MenuItem[] => [
    { label: "Settings", onSelect: () => onNavigate(`/projects/${project.id}/settings`) },
    { label: "Open on GitHub", onSelect: () => openGithub({ label: "", url: project.repoUrl }) },
    { label: "Delete project", danger: true, onSelect: () => setPending({ kind: "deleteProject", id: project.id, name: project.name }) },
  ];

  const runPending = async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      if (pending.kind === "terminate") {
        await api("sessionTerminate", { id: pending.id });
      } else {
        await api("projectDelete", { id: pending.id });
        onNavigate("/");
      }
      setPending(null);
      onChanged();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "The daemon refused the request");
    } finally {
      setBusy(false);
    }
  };

  const saveRename = async (id: string, value: string) => {
    setRenaming(null);
    const label = value.trim();
    if (label === "") return;
    try {
      await api("sessionLabel", { id }, { label });
      onChanged();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "The daemon refused the request");
    }
  };

  const renderSessionRow = (view: SessionView, level: number, items: MenuItem[]) => {
    const row = sessionRow(view);
    const badge = view.state !== null ? stateBadge(view.state) : null;
    const editing = renaming?.id === view.session.id;
    return (
      <div key={view.session.id} className="srow-line" data-selected={selectedId === view.session.id || undefined}>
        {editing ? (
          <input
            type="text"
            className="srow__rename"
            style={{ paddingLeft: `calc(10px + ${level} * 16px)` }}
            aria-label="Session name"
            defaultValue={renaming.value}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveRename(view.session.id, event.currentTarget.value);
              else if (event.key === "Escape") setRenaming(null);
            }}
            onBlur={(event) => void saveRename(view.session.id, event.currentTarget.value)}
          />
        ) : (
          <button
            type="button"
            className="srow"
            style={{ paddingLeft: `calc(10px + ${level} * 16px)` }}
            title={rowText(view)}
            onClick={() => onNavigate(`/sessions/${view.session.id}`)}
          >
            {row.num !== null && <span className="srow__num">{row.num}</span>}
            {row.glyph !== null && <span className="srow__glyph" aria-hidden="true">{row.glyph}</span>}
            <span className="srow__label">{row.label}</span>
            {view.session.lastActivityAt !== null && (
              <span className="srow__time">{relativeTime(view.session.lastActivityAt, now)}</span>
            )}
            {badge !== null && (
              <Badge tone={badge.tone} dot>
                {badge.label}
              </Badge>
            )}
          </button>
        )}
        {items.length > 0 && (
          <button
            type="button"
            className="srow__menu"
            aria-label={`Actions for ${rowText(view)}`}
            onClick={(event) => openMenu(event, items)}
          >
            ⋯
          </button>
        )}
      </div>
    );
  };

  const renderProject = (node: ProjectNode) => {
    const isCollapsed = collapsed.has(node.project.id);
    const showArchived = archivedOpen.has(node.project.id);
    const rows: ReturnType<typeof renderSessionRow>[] = [];
    if (node.orchestrator !== null) rows.push(renderSessionRow(node.orchestrator, 1, []));
    for (const worker of node.workers) {
      rows.push(renderSessionRow(worker.view, 1, sessionMenu(node.project, worker.view)));
      for (const reviewer of worker.reviewers) {
        rows.push(renderSessionRow(reviewer, 2, sessionMenu(node.project, reviewer)));
      }
    }
    return (
      <div key={node.project.id} className="sidebar__project">
        <div className="srow-line">
          <button
            type="button"
            className="srow"
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsed(toggled(collapsed, node.project.id))}
          >
            <span className="srow__chevron" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
            <span className="srow__label">{node.project.name}</span>
            {node.reviewAccess !== null && (
              <span title={node.reviewAccess}>
                <Badge tone="red">review account has no access</Badge>
              </span>
            )}
          </button>
          <button
            type="button"
            className="srow__menu"
            aria-label={`Actions for ${node.project.name}`}
            onClick={(event) => openMenu(event, projectMenu(node.project))}
          >
            ⋯
          </button>
        </div>
        {!isCollapsed && (
          <>
            {rows}
            {node.archived.length > 0 && (
              <>
                <button
                  type="button"
                  className="srow srow--muted"
                  style={{ paddingLeft: "10px" }}
                  aria-expanded={showArchived}
                  onClick={() => setArchivedOpen(toggled(archivedOpen, node.project.id))}
                >
                  <span className="srow__chevron" aria-hidden="true">{showArchived ? "▾" : "▸"}</span>
                  <span className="srow__label">Archived ({node.archived.length})</span>
                </button>
                {showArchived &&
                  node.archived.map((view) => {
                    const badge = view.state !== null ? stateBadge(view.state) : null;
                    return (
                      <button
                        key={view.session.id}
                        type="button"
                        className="srow srow--dead"
                        style={{ paddingLeft: "calc(10px + 16px)" }}
                        title={rowText(view)}
                        onClick={() => onNavigate(`/sessions/${view.session.id}`)}
                      >
                        <span className="srow__label">{rowText(view)}</span>
                        {badge !== null && (
                          <Badge tone="dim" dot>
                            {badge.label}
                          </Badge>
                        )}
                      </button>
                    );
                  })}
              </>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <nav className="sidebar" aria-label="Sessions">
      {tree.globalAgent !== null && renderSessionRow(tree.globalAgent, 0, [])}
      {tree.projects.map(renderProject)}
      <button type="button" className="srow sidebar__add" onClick={() => onNavigate("/onboarding")}>
        <span className="srow__label">+ Add project</span>
      </button>
      {menu !== null && <RowMenu menu={menu} onClose={() => setMenu(null)} />}
      <Dialog
        open={pending !== null}
        title={
          pending === null
            ? ""
            : pending.kind === "terminate"
              ? pending.title
              : `Delete project ${pending.name}?`
        }
        danger
        busy={busy}
        confirmLabel={pending?.kind === "terminate" ? "Terminate" : "Delete"}
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      >
        {pending?.kind === "deleteProject" ? "Its sessions and settings are removed; GitHub is untouched." : null}
      </Dialog>
    </nav>
  );
}
