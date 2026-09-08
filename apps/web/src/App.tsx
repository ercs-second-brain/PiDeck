import { useState } from "react";
import { Link, Outlet, RouterProvider, createBrowserRouter, useParams, useNavigate } from "react-router";
import type { Project } from "@pideck/shared";
import { UpdateBanner } from "./components/UpdateBanner";
import { NodeVersionWarning } from "./components/NodeVersionWarning";
import { NotificationBell } from "./components/NotificationCenter";
import { AllProjectsBoard } from "./routes/AllProjectsBoard";
import { BoardPage } from "./routes/BoardPage";
import { DiffPage } from "./routes/DiffPage";
import { GlobalOnboardingModal } from "./routes/onboarding/GlobalOnboarding";
import { OnboardingModal } from "./routes/OnboardingWizard";
import { SettingsPage, GlobalSettingsPage } from "./routes/SettingsPage";
import { useOnboardingGates } from "./routes/use-onboarding-gates";
import { TerminalPage } from "./terminal/TerminalPage";
import { SessionPicker } from "./terminal/SessionPicker";
import { SidebarContext, useSidebarData } from "./terminal/sidebar";

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
 * `/projects/:projectId`, `/settings`, …).
 *
 * pi/gh auth is PiDeck-global (issues #183, #209): unless the daemon's
 * probes report ready or the recorded shell onboarding says done, the
 * global onboarding modal opens ahead of any project work; finishing it
 * chains into project onboarding when no project exists yet. The order is
 * strict — global first, project second, never both at once — and a
 * fully-configured machine opens zero modals.
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
      { path: "settings", element: <GlobalSettingsPage /> },
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
  const { entries, error, loaded, startingProjectId, reload, startOrchestrator, terminateWorker, deleteProject } =
    useSidebarData((sessionId) => navigateFromSidebar(`/terminal/${sessionId}`));
  // The two onboarding modals (issues #62, #90, #183): see use-onboarding-gates.
  const onboarding = useOnboardingGates({ loaded, error, entryCount: entries.length });
  // Issue #93: on small viewports the sidebar collapses into a drawer; the
  // hamburger (header) opens it, navigating or tapping the backdrop closes it.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigateFromSidebar = (to: string) => {
    setSidebarOpen(false);
    navigate(to);
  };

  const sidebar = {
    entries,
    error,
    loaded,
    startingProjectId,
    reload,
    startOrchestrator: (projectId: string) => startOrchestrator(projectId),
    terminateWorker,
    deleteProject,
    openOnboarding: onboarding.openProject,
  };

  // Issue #172: after a successful delete, leave the deleted project's
  // board/settings/diff route — its data is gone.
  const deleteProjectAndLeave = async (deletedId: string) => {
    await deleteProject(deletedId);
    if (projectId === deletedId) navigate("/");
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
          Pi<span className="brand-accent">Deck</span>
        </Link>
        <div className="header-actions">
          <NotificationBell />
        </div>
      </header>
      <UpdateBanner />
      <NodeVersionWarning />
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
            onStartOnboarding={onboarding.openProject}
            onOpenGlobalSettings={() => navigateFromSidebar("/settings")}
            onStartOrchestrator={(projectId) => startOrchestrator(projectId)}
            onTerminateWorker={terminateWorker}
            onDeleteProject={deleteProjectAndLeave}
          />
          <main className="app-main">
            <Outlet />
          </main>
        </SidebarContext.Provider>
      </div>
      <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      {onboarding.globalOpen && (
        <GlobalOnboardingModal onClose={onboarding.closeGlobal} onFinished={onboarding.finishGlobal} />
      )}
      {onboarding.projectOpen && (
        <OnboardingModal
          onClose={onboarding.closeProject}
          onRegistered={(project: Project) => {
            onboarding.closeProject();
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
