import { useEffect, useRef, useState } from "react";
import { Link, Outlet, RouterProvider, createBrowserRouter, useParams, useNavigate } from "react-router";
import type { Project } from "@agentskiss/shared";
import { UpdateBanner } from "./components/UpdateBanner";
import { AllProjectsBoard } from "./routes/AllProjectsBoard";
import { BoardPage } from "./routes/BoardPage";
import { DiffPage } from "./routes/DiffPage";
import { OnboardingModal } from "./routes/OnboardingWizard";
import { SettingsPage } from "./routes/SettingsPage";
import { TerminalPage } from "./terminal/TerminalPage";
import { SessionPicker } from "./terminal/SessionPicker";
import { SidebarContext, useSidebarData } from "./terminal/sidebar";

/**
 * The whole app is one page (issue #62): the terminals page. The sidebar
 * (SessionPicker) is the app's navigation — "Projects" header with a "+"
 * onboarding button, per-project rows that open the project's kanban in the
 * main pane, and per-agent rows that attach terminals — while the main pane
 * renders the terminal, the all-projects combined board, a project board,
 * settings, or a PR diff. Deep links keep working (`/terminal/:sessionId`,
 * `/projects/:projectId`, …).
 *
 * The app header contains `<Link>`s, so it must render *inside* the router
 * context — it lives in the root layout route (`Shell`), not around
 * `RouterProvider`.
 */
const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <AllProjectsBoard /> },
      { path: "terminal", element: <TerminalPage /> },
      { path: "terminal/:sessionId", element: <TerminalPage /> },
      { path: "projects/:projectId", element: <BoardPage /> },
      { path: "projects/:projectId/settings", element: <SettingsPage /> },
      { path: "projects/:projectId/pulls/:prNumber", element: <DiffPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

function Shell() {
  const navigate = useNavigate();
  // Layout route: params from the matched child (e.g. /terminal/:sessionId,
  // /projects/:projectId) are merged in, so the sidebar can mark the
  // currently attached session / open project.
  const { sessionId, projectId } = useParams();
  const { entries, error, startingProjectId, reload, startOrchestrator, terminateWorker } = useSidebarData((sessionId) =>
    navigateFromSidebar(`/terminal/${sessionId}`),
  );
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  // Issue #93: on small viewports the sidebar collapses into a drawer; the
  // hamburger (header) opens it, navigating or tapping the backdrop closes it.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const autoOpened = useRef(false);
  const navigateFromSidebar = (to: string) => {
    setSidebarOpen(false);
    navigate(to);
  };

  // First run with zero projects: lead into onboarding once (the sidebar
  // "+" and the empty-state CTA stay available for every later need).
  useEffect(() => {
    if (!autoOpened.current && !error && entries.length === 0) {
      autoOpened.current = true;
      setOnboardingOpen(true);
    }
  }, [error, entries.length]);

  const sidebar = {
    entries,
    error,
    startingProjectId,
    reload,
    startOrchestrator: (projectId: string) => startOrchestrator(projectId),
    terminateWorker,
    openOnboarding: () => setOnboardingOpen(true),
  };

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`}>
      <header className="app-header">
        <button
          type="button"
          className="menu-toggle"
          aria-label="Toggle the project sidebar"
          title="Projects"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          ☰
        </button>
        <Link to="/" className="brand">
          agents<span className="brand-accent">KISS</span>
        </Link>
        <Link to="/terminal" className="nav-link">
          Terminals
        </Link>
        <span className="brand-tag">agent orchestration, self-hosted</span>
      </header>
      <UpdateBanner />
      <div className="app-body">
        <SidebarContext.Provider value={sidebar}>
          <SessionPicker
            entries={entries}
            error={error}
            selectedSessionId={sessionId ?? null}
            selectedProjectId={projectId ?? null}
            startingProjectId={startingProjectId}
            onSelectSession={(id) => navigateFromSidebar(`/terminal/${id}`)}
            onSelectProject={(projectId) => navigateFromSidebar(`/projects/${projectId}`)}
            onSelectAllProjects={() => navigateFromSidebar("/")}
            onStartOnboarding={() => setOnboardingOpen(true)}
            onStartOrchestrator={(projectId) => startOrchestrator(projectId)}
            onTerminateWorker={terminateWorker}
          />
          <main className="app-main">
            <Outlet />
          </main>
        </SidebarContext.Provider>
      </div>
      <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      {onboardingOpen && (
        <OnboardingModal
          onClose={() => setOnboardingOpen(false)}
          onRegistered={(project: Project) => {
            setOnboardingOpen(false);
            reload();
            navigate(`/projects/${project.id}`);
          }}
        />
      )}
    </div>
  );
}

function NotFound() {
  return (
    <main className="page">
      <p className="empty">Page not found.</p>
      <Link to="/" className="back-link">
        ← All projects
      </Link>
    </main>
  );
}

export function App() {
  return <RouterProvider router={router} />;
}
