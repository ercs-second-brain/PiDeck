import { useEffect, useRef, useState } from "react";
import { Link, Outlet, RouterProvider, createBrowserRouter, useParams, useNavigate } from "react-router";
import type { Project } from "@pideck/shared";
import { UpdateBanner } from "./components/UpdateBanner";
import { NotificationBell } from "./components/NotificationCenter";
import { AllProjectsBoard } from "./routes/AllProjectsBoard";
import { BoardPage } from "./routes/BoardPage";
import { DiffPage } from "./routes/DiffPage";
import { OnboardingModal } from "./routes/OnboardingWizard";
import { SettingsPage } from "./routes/SettingsPage";
import { TerminalPage } from "./terminal/TerminalPage";
import { SessionPicker } from "./terminal/SessionPicker";
import { shouldAutoOpenOnboarding, SidebarContext, useSidebarData } from "./terminal/sidebar";

/**
 * The whole app is one page (issue #62): the terminals page. The app header
 * carries only the brand and tag — the Terminals link is gone since the
 * single page *is* the terminals view (issue #103) and deep links to
 * `/terminal/:sessionId` keep working. The sidebar
 * (SessionPicker) is the app's navigation — "Projects" header with a "+"
 * onboarding button, per-project rows whose NAME opens the project's
 * kanban board (#173, the original #62 behavior) with a chat icon
 * attaching/starting the project's orchestrator (#108/#53) and a ⋯ menu
 * opening the project's settings (#167), and per-agent
 * rows that attach terminals — while the main pane
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
  const { entries, error, loaded, startingProjectId, reload, startOrchestrator, terminateWorker } = useSidebarData((sessionId) =>
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
  // Issue #90: "zero projects" only counts after the project list actually
  // loaded — the pre-load empty state must not open the wizard.
  useEffect(() => {
    if (!autoOpened.current && shouldAutoOpenOnboarding({ loaded, error, entryCount: entries.length })) {
      autoOpened.current = true;
      setOnboardingOpen(true);
    }
  }, [loaded, error, entries.length]);

  const sidebar = {
    entries,
    error,
    loaded,
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
        <span className="brand-tag">agent orchestration, self-hosted</span>
        <div className="header-actions">
          <NotificationBell />
        </div>
      </header>
      <UpdateBanner />
      <div className="app-body">
        <SidebarContext.Provider value={sidebar}>
          <SessionPicker
            entries={entries}
            error={error}
            loading={!loaded}
            selectedSessionId={sessionId ?? null}
            selectedProjectId={projectId ?? null}
            startingProjectId={startingProjectId}
            onSelectSession={(id) => navigateFromSidebar(`/terminal/${id}`)}
            onSelectProject={(projectId) => navigateFromSidebar(`/projects/${projectId}`)}
            onOpenSettings={(projectId) => navigateFromSidebar(`/projects/${projectId}/settings`)}
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
