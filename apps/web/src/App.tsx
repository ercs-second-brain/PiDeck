import { useEffect, useState } from "react";
import { Link, Outlet, RouterProvider, createBrowserRouter, useParams, useNavigate, useLocation } from "react-router";
import type { Project } from "@pideck/shared";
import { UpdateBanner } from "./components/UpdateBanner";
import { NotificationBell } from "./components/NotificationCenter";
import { AllProjectsBoard } from "./routes/AllProjectsBoard";
import { BoardPage } from "./routes/BoardPage";
import { DiffPage } from "./routes/DiffPage";
import { GlobalOnboardingModal } from "./routes/onboarding/GlobalOnboarding";
import { OnboardingModal } from "./routes/OnboardingWizard";
import { GlobalSettingsModal, ProjectSettingsModal } from "./routes/SettingsModal";
import { AgentAssetsModal } from "./routes/AgentAssetsModal";
import { useOnboardingGates } from "./routes/use-onboarding-gates";
import { TerminalPage } from "./terminal/TerminalPage";
import { SessionPicker } from "./terminal/SessionPicker";
import { SidebarContext, useSidebarData } from "./terminal/sidebar";
import {
  isMobileViewport,
  loadSidebarOpen,
  saveSidebarOpen,
  shouldAutoCloseSidebar,
  SIDEBAR_DRAWER_QUERY,
} from "./lib/sidebar-open";

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
 * `RouterProvider`. The hamburger (issue #326) toggles the sidebar's single
 * open/closed state: the drawer slides in on mobile, the sidebar slides off
 * and back on desktop — persisted in localStorage under per-viewport keys
 * (issue #364), so the mobile drawer's auto-close never overwrites the
 * desktop's persisted choice.
 * Issue #354: the hamburger is mobile-only; on desktop the toggle is a
 * small icon at the top right of the sidebar itself, and the collapse is
 * manual-only — the user's open/closed choice is never overridden.
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

/**
 * App header: sidebar toggle + centered brand (needs `<Link>`, so it renders
 * inside the router). Issue #278 (B22): the brand — the #265 icon mark to
 * the left of the product name — is centered in the header regardless of
 * the hamburger/bell widths.
 */
function AppHeader(props: { sidebarOpen: boolean; onToggleSidebar: () => void }) {
  return (
    <header className="app-header">
      <button
        type="button"
        className="menu-toggle"
        aria-label="Toggle the project sidebar"
        title="Projects"
        aria-expanded={props.sidebarOpen}
        onClick={props.onToggleSidebar}
      >
        ☰
      </button>
      <Link to="/" className="brand">
        {/* The icon mark (#265) — the same asset as the favicon/PWA icon. */}
        <img src="/icon.svg" alt="" className="brand-logo" />
        <span className="brand-copy">
          <span className="brand-name">
            Pi<span className="brand-accent">Deck</span>
          </span>
          {/* Issue #298 (B29): the tagline as a tiny dim subtext under the
              brand — the old side-by-side tagline crowded the header (#231);
              this one reads as brand lockup, not header chrome. */}
          <span className="brand-tagline">let 'em cook</span>
        </span>
      </Link>
      <div className="header-actions">
        <NotificationBell />
      </div>
    </header>
  );
}

/** Issue #260 (B8): the update popup's live content — mounted through the
 *  sidebar's footer slot so it anchors above the settings entry. Quiet
 *  (renders nothing) when there is nothing to report. #256: the node
 *  too-old strip stays inside the update banner — one warning surface. */
function UpdatePopup() {
  return <UpdateBanner />;
}

/**
 * Issue #326: one toggle-controlled visibility state for every viewport —
 * the mobile drawer (issue #93) on ≤768px, a slide-off collapse on desktop
 * — persisted in localStorage so it survives reloads. When the viewport
 * crosses into the mobile breakpoint the drawer closes (a desktop-open
 * state must not cover the main pane as a drawer).
 *
 * Issue #354: the close() side effect is mobile-only (see
 * {@link shouldAutoCloseSidebar}). On desktop, navigation or opening a
 * settings modal never collapses the sidebar — the user's choice persists;
 * only the toggle itself (sidebar icon on desktop, hamburger on mobile)
 * and the breakpoint crossing change it.
 */
function useSidebarOpen(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(loadSidebarOpen);
  const [mobile, setMobile] = useState(isMobileViewport);
  useEffect(() => saveSidebarOpen(open), [open]);
  useEffect(() => {
    const drawer = window.matchMedia(SIDEBAR_DRAWER_QUERY);
    const onChange = (e: MediaQueryListEvent): void => {
      setMobile(e.matches);
      if (e.matches) setOpen(false);
    };
    drawer.addEventListener("change", onChange);
    return () => drawer.removeEventListener("change", onChange);
  }, []);
  return [
    open,
    () => setOpen((o) => !o),
    () => {
      if (shouldAutoCloseSidebar(mobile)) setOpen(false);
    },
  ];
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
    deleteProject, spawnAgentSession, terminateAgentSession, agentKinds,
  } = useSidebarData((sessionId) => navigateFromSidebar(`/terminal/${sessionId}`));
  // The two onboarding modals (issues #62, #90, #183): see use-onboarding-gates.
  const onboarding = useOnboardingGates({ loaded, error, entryCount: entries.length });
  const [sidebarOpen, toggleSidebar, closeSidebar] = useSidebarOpen();
  const settings = useSettingsModal();
  const navigateFromSidebar = (to: string) => { closeSidebar(); navigate(to); };
  /** Opens a settings-kind modal over the current view (#264, #315). */
  const openSettings = (kind: "global" | "agent-assets") => { closeSidebar(); settings.open({ kind }); };

  const sidebar = {
    entries,
    error, loaded,
    startingProjectId,
    globalAgent, startingGlobalAgent,
    reload,
    startOrchestrator,
    startGlobalAgent,
    terminateWorker,
    deleteProject, spawnAgentSession, terminateAgentSession, agentKinds,
    openOnboarding: onboarding.openProject,
  };

  const deleteProjectAndLeave = async (deletedId: string) => {
    await deleteProject(deletedId);
    // Issue #172: leave the deleted project's board/diff route — its data is gone.
    if (projectId === deletedId) navigate("/");
  };

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`}>
      <AppHeader sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
      <div className="app-body">
        <SidebarContext.Provider value={sidebar}>
          <SessionPicker
            entries={entries}
            error={error}
            loading={!loaded}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={toggleSidebar}
            selectedSessionId={sessionId ?? null}
            selectedProjectId={projectId ?? null}
            allProjectsSelected={pathname === "/"}
            startingProjectId={startingProjectId}
            agentKinds={agentKinds}
            globalAgent={globalAgent}
            startingGlobalAgent={startingGlobalAgent}
            onSelectSession={(id) => navigateFromSidebar(`/terminal/${id}`)}
            onSelectProject={(projectId) => navigateFromSidebar(`/projects/${projectId}`)}
            onOpenSettings={(projectId) => {
              closeSidebar();
              settings.open({ kind: "project", projectId });
            }}
            onSelectAllProjects={() => navigateFromSidebar("/")}
            onStartOnboarding={onboarding.openProject}
            onOpenGlobalSettings={() => openSettings("global")}
            onOpenAgentAssets={() => openSettings("agent-assets")}
            onStartOrchestrator={(projectId) => startOrchestrator(projectId)}
            onStartGlobalAgent={startGlobalAgent}
            onTerminateWorker={terminateWorker}
            onDeleteProject={deleteProjectAndLeave}
            onSpawnAgentSession={spawnAgentSession}
            onTerminateAgentSession={terminateAgentSession}
            updateSlot={<UpdatePopup />}
          />
          <main className="app-main">
            <Outlet />
          </main>
        </SidebarContext.Provider>
      </div>
      <div className="sidebar-backdrop" onClick={closeSidebar} />
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
  const [modal, setModal] = useState<{ kind: "global" } | { kind: "project"; projectId: string } | { kind: "agent-assets" } | null>(null);
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
  settingsModal: { kind: "global" } | { kind: "project"; projectId: string } | { kind: "agent-assets" } | null;
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
      {settingsModal?.kind === "agent-assets" && <AgentAssetsModal onClose={onCloseSettings} />}
    </>
  );
}

function NotFound() {
  return (
    <main className="page">
      {/* Issue #277: navigation lives in the sidebar — no back-link here. */}
      <p className="empty">Page not found.</p>
    </main>
  );
}

export function App() {
  return <RouterProvider router={router} />;
}
