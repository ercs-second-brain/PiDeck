import { useState, type ReactNode } from "react";
import type { Project, SessionView } from "@pideck/shared";
import type { Route } from "../router";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import "./shell.css";

const COLLAPSED_KEY = "pideck.sidebar.collapsed";

/** Desktop sidebar visibility, remembered across reloads. */
function useSidebarCollapsed(): [boolean, (value: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === "1");
  const set = (value: boolean) => {
    setCollapsed(value);
    localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  };
  return [collapsed, set];
}

export interface ShellProps {
  route: Route;
  context: string | null;
  projects: Project[];
  sessions: SessionView[];
  selectedId: string | null;
  onNavigate: (path: string) => void;
  onChanged: () => void;
  onToast: (message: string) => void;
  /** The main pane hosts the terminal: no scroll, edge to edge. */
  fill: boolean;
  children: ReactNode;
}

/**
 * The app frame: header on top, below it the 280px sidebar and the main pane
 * (which hosts exactly one of terminal / page / empty state). On mobile the
 * two never show together: the sidebar is the home screen, the main pane is
 * a full-screen detail view reached via history (browser back returns).
 */
export function Shell({ route, context, fill, children, ...sidebarProps }: ShellProps) {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const detail = route.name !== "home";
  return (
    <div className={`shell${collapsed ? " shell--collapsed" : ""}${detail ? " shell--detail" : ""}`}>
      <Header
        context={context}
        detail={detail}
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        onNavigate={sidebarProps.onNavigate}
      />
      <div className="shell__body">
        <Sidebar {...sidebarProps} />
        <main className={`shell__main${fill ? " shell__main--fill" : ""}`}>{children}</main>
      </div>
    </div>
  );
}
