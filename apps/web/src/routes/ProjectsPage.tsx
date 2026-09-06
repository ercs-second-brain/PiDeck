import { Link } from "react-router";
import { useAppState } from "../store/store";

/** Project list page — the app entry point, navigates to a board per project. */
export function ProjectsPage() {
  const state = useAppState();
  return (
    <main className="page">
      <h1 className="page-title">Projects</h1>
      <ul className="project-list">
        {state.projects.map((project) => (
          <li key={project.id}>
            <Link to={`/projects/${project.id}`} className="project-card">
              <span className="project-name">{project.name}</span>
              <span className="project-repo">{project.repoUrl}</span>
              <span className="project-meta">
                branch <code>{project.defaultBranch}</code>
                {project.settings.autoAgentUsername && (
                  <span className="project-auto">
                    {" "}
                    · auto-spawn <code>@{project.settings.autoAgentUsername}</code>
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {state.projects.length === 0 && <p className="empty">No projects yet.</p>}
    </main>
  );
}
