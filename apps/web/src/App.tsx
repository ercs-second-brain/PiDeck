import { Link, Outlet, RouterProvider, createBrowserRouter } from "react-router";
import { BoardPage } from "./routes/BoardPage";
import { DiffPage } from "./routes/DiffPage";
import { ProjectsPage } from "./routes/ProjectsPage";
import { OnboardingPage } from "./routes/OnboardingPage";
import { SettingsPage } from "./routes/SettingsPage";
import { TerminalPage } from "./terminal/TerminalPage";

/**
 * Shell: project list → onboarding wizard → board / diff / settings per
 * project, plus the browser terminal.
 *
 * Information architecture (issues #53/#54): the standalone ProjectsPage
 * remains the app home — it hosts the first-run onboarding wizard and the
 * per-project board links. The Terminals page carries its own project
 * navigation: its sidebar lists every registered project top-level with the
 * project's orchestrator + worker sessions nested beneath (and a start
 * affordance for projects that have no orchestrator yet), so agents are one
 * click away without duplicating project CRUD in the terminal view.
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
      { index: true, element: <ProjectsPage /> },
      { path: "onboarding", element: <OnboardingPage /> },
      { path: "projects/:projectId", element: <BoardPage /> },
      { path: "projects/:projectId/settings", element: <SettingsPage /> },
      { path: "projects/:projectId/pulls/:prNumber", element: <DiffPage /> },
      { path: "terminal", element: <TerminalPage /> },
      { path: "terminal/:sessionId", element: <TerminalPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

function Shell() {
  return (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">
          agents<span className="brand-accent">KISS</span>
        </Link>
        <Link to="/terminal" className="nav-link">
          Terminals
        </Link>
        <span className="brand-tag">agent orchestration, self-hosted</span>
      </header>
      <Outlet />
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
