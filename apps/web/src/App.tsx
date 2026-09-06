import { Link, RouterProvider, createBrowserRouter } from "react-router";
import { BoardPage } from "./routes/BoardPage";
import { ProjectsPage } from "./routes/ProjectsPage";

// Simple shell: project list → board per project. No landing page, no auth.
const router = createBrowserRouter([
  { path: "/", element: <ProjectsPage /> },
  { path: "/projects/:projectId", element: <BoardPage /> },
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
        <span className="brand-tag">agent orchestration, self-hosted</span>
      </header>
      <RouterProvider router={router} />
    </div>
  );
}
