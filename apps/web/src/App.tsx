import { useState } from "react";
import { Link, Outlet, RouterProvider, createBrowserRouter, useParams, useNavigate, useLocation } from "react-router";
import type { Project } from "@pideck/shared";
import { UpdateBanner } from "./components/UpdateBanner";
import { NodeVersionWarning } from "./components/NodeVersionWarning";
import { NotificationBell } from "./components/NotificationCenter";
import { AllProjectsBoard } from "./routes/AllProjectsBoard";
import { BoardPage } from "./routes/BoardPage";
import { DiffPage } from "./routes/DiffPage";
import { GlobalOnboardingModal } from "./routes/onboarding/GlobalOnboarding";
import { OnboardingModal } from "./routes/OnboardingWizard";
import { GlobalSettingsModal, ProjectSettingsModal } from "./routes/SettingsModal";
import { useOnboardingGates } from "./routes/use-onboarding-gates";
import { TerminalPage } from "./terminal/TerminalPage";
import { SessionPicker } from "./terminal/SessionPicker";
import { SidebarContext, useSidebarData } from "./terminal/sidebar";

/**
 * The whole app is one page (issue #62): the terminals page. The app header
 * carries only the brand and tag — the Terminals link is gone since the
 * single page *is* the terminals view (issue #103) and deep links to
 * `/terminal/:sessionId` keep working. The sidebar
 * (SessionPicker) is the app's navigation — a "Workspace" row (issue #259:
 * the renamed global-agent entry, disabled until a project exists) whose
 * name opens the all-projects board, per-project rows whose NAME opens the
 * project's kanban board (#173, the original #62 behavior) with a chat icon
 * attaching/starting the project's orchestrator (#108/#53) and a ⋯ menu
 * opening the project's settings (#167), an "+ Add project" bottom row
 * (issue #259), and per-agent rows that attach terminals — while the main
 * pane renders the terminal, the all-projects combined board, a project
 * board, or a PR diff. Settings are modal dialogs over the current view
 * (issue #264): the project's ⋯ menu opens the project settings modal, the
 * sidebar footer the global one — there are no settings routes anymore.
 * Deep links keep working (`/terminal/:sessionId`, `/projects/:projectId`,
 * …).
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
      { path: "projects/:projectId/pulls/:prNumber", element: <DiffPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

/** App header: sidebar toggle + brand (needs `<Link>`, so it renders inside the router). */
function AppHeader(props: { sidebarOpen: boolean; onToggleSidebar: () => void }) {
  return (
    <header className="app-header">
      <button
        type="button"
        className="menu-toggle"
        aria-label="Toggle the project sidebar"
        title="Projects"
        onClick={props.onToggleSidebar}
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
  );
}

/** Issue #260 (B8): the update popup's live content — mounted through the
 *  sidebar's footer slot so it anchors above the settings entry. Both
 *  surfaces are quiet (render nothing) when there is nothing to report. */
function UpdatePopup() {
  return (
    <>
      <UpdateBanner />
      <NodeVersionWarning />
    </>
  );
}

function Shell() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Layout route: params from the matched child (e.g. /terminal/:sessionId,
  // /projects/:projectId) are merged in, so the sidebar can mark the
  // currently attached session / open project.
  const { sessionId, projectId } = useParams();
  const {
    entries,
    error,
    loaded,
    startingProjectId,
    globalAgent,
    startingGlobalAgent,
    reload,
    startOrchestrator,
    startGlobalAgent,
    terminateWorker,
    deleteProject,
  } = useSidebarData((sessionId) => navigateFromSidebar(`/terminal/${sessionId}`));
  // The two onboarding modals (issues #62, #90, #183): see use-onboarding-gates.
  const onboarding = useOnboardingGates({ loaded, error, entryCount: entries.length });
  // Issue #93: on small viewports the sidebar is a drawer — hamburger opens it, navigating closes it.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const settings = useSettingsModal();
  const navigateFromSidebar = (to: string) => {
    setSidebarOpen(false);
    navigate(to);
  };

  const sidebar = {
    entries,
    error,
    loaded,
    startingProjectId,
    globalAgent,
    startingGlobalAgent,
    reload,
    startOrchestrator: (projectId: string) => startOrchestrator(projectId),
    startGlobalAgent: () => startGlobalAgent(),
    terminateWorker,
    deleteProject,
    openOnboarding: onboarding.openProject,
  };

  const deleteProjectAndLeave = async (deletedId: string) => {
    await deleteProject(deletedId);
    // Issue #172: leave the deleted project's board/diff route — its data is gone.
    if (projectId === deletedId) navigate("/");
  };

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`}>
      <AppHeader sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
      <div className="app-body">
        <SidebarContext.Provider value={sidebar}>
          <SessionPicker
            entries={entries}
            error={error}
            loading={!loaded}
            selectedSessionId={sessionId ?? null}
            selectedProjectId={projectId ?? null}
            allProjectsSelected={pathname === "/"}
            startingProjectId={startingProjectId}
            globalAgent={globalAgent}
            startingGlobalAgent={startingGlobalAgent}
            onSelectSession={(id) => navigateFromSidebar(`/terminal/${id}`)}
            onSelectProject={(projectId) => navigateFromSidebar(`/projects/${projectId}`)}
            onOpenSettings={(projectId) => {
              setSidebarOpen(false);
              settings.open({ kind: "project", projectId });
            }}
            onSelectAllProjects={() => navigateFromSidebar("/")}
            onStartOnboarding={onboarding.openProject}
            onOpenGlobalSettings={() => {
              setSidebarOpen(false);
              settings.open({ kind: "global" });
            }}
            onStartOrchestrator={(projectId) => startOrchestrator(projectId)}
            onStartGlobalAgent={startGlobalAgent}
            onTerminateWorker={terminateWorker}
            onDeleteProject={deleteProjectAndLeave}
            updateSlot={<UpdatePopup />}
          />
          <main className="app-main">
            <Outlet />
          </main>
        </SidebarContext.Provider>
      </div>
      <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      <AppModals
        onboarding={onboarding}
        settingsModal={settings.modal}
        onCloseSettings={settings.close}
        onProjectRegistered={(project: Project) => {
          onboarding.closeProject();
          reload();
          navigate(`/projects/${project.id}`);
        }}
      />
    </div>
  );
}

/**
 * Settings modal state for the Shell (issue #264): which settings dialog is
 * open over the current view — global, or one project's — or none.
 */
function useSettingsModal() {
  const [modal, setModal] = useState<{ kind: "global" } | { kind: "project"; projectId: string } | null>(null);
  return {
    modal,
    open: (next: NonNullable<typeof modal>) => setModal(next),
    close: () => setModal(null),
  };
}

/**
 * All app-level modal dialogs, rendered over the current main pane by the
 * Shell: the onboarding gates (issues #62, #90, #183) and the settings
 * dialogs (issue #264 — opened by the sidebar's per-project ⋯ menu and the
 * footer's global button, closed by the × in the card; no navigation).
 */
function AppModals(props: {
  onboarding: ReturnType<typeof useOnboardingGates>;
  settingsModal: { kind: "global" } | { kind: "project"; projectId: string } | null;
  onCloseSettings: () => void;
  onProjectRegistered: (project: Project) => void;
}) {
  const { onboarding, settingsModal, onCloseSettings, onProjectRegistered } = props;
  return (
    <>
      {onboarding.globalOpen && (
        <GlobalOnboardingModal onClose={onboarding.closeGlobal} onFinished={onboarding.finishGlobal} />
      )}
      {onboarding.projectOpen && <OnboardingModal onClose={onboarding.closeProject} onRegistered={onProjectRegistered} />}
      {settingsModal?.kind === "global" && <GlobalSettingsModal onClose={onCloseSettings} />}
      {settingsModal?.kind === "project" && (
        <ProjectSettingsModal projectId={settingsModal.projectId} onClose={onCloseSettings} />
      )}
    </>
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
