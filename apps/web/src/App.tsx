import { Link, RouterProvider, createBrowserRouter } from "react-router";
import { BoardPage } from "./routes/BoardPage";
import { ProjectsPage } from "./routes/ProjectsPage";
import { TerminalPage } from "./terminal/TerminalPage";

// Simple shell: project list → board per project, plus the browser terminal.
const router = createBrowserRouter([
  { path: "/", element: <ProjectsPage /> },
  { path: "/projects/:projectId", element: <BoardPage /> },
  { path: "/terminal", element: <TerminalPage /> },
  { path: "/terminal/:sessionId", element: <TerminalPage /> },
  { path: "*", element: <NotFound /> },
]);

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
      <RouterProvider router={router} />
    </div>
  );
}
