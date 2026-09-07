import { useEffect } from "react";
import { Link } from "react-router";
import { boardStore, useAppState } from "../store/store";
import { UpdateBanner } from "../components/UpdateBanner";
import { OnboardingPage } from "./OnboardingPage";

/**
 * Project list page — the app entry point. With no registered projects the
 * first-run onboarding wizard takes over; otherwise it lists one card per
 * project linking to its live board.
 */
export function ProjectsPage() {
  const state = useAppState();

  useEffect(() => {
    void boardStore.refresh().catch(() => {});
  }, []);

  if (!state.loaded) {
    return (
      <main className="page">
        <h1 className="page-title">Projects</h1>
        <p className="empty">Loading…</p>
      </main>
    );
  }

  if (state.loadError !== null) {
    return (
      <main className="page">
        <UpdateBanner />
        <h1 className="page-title">Projects</h1>
        <p className="error-note">Could not reach the daemon: {state.loadError}</p>
        <button type="button" className="button" onClick={() => void boardStore.refresh().catch(() => {})}>
          Retry
        </button>
      </main>
    );
  }

  if (state.projects.length === 0) {
    // First run: no projects registered → onboarding wizard.
    return <OnboardingPage />;
  }

  return (
    <main className="page">
      <UpdateBanner />
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
      <p className="empty">
        New project?{" "}
        <Link to="/onboarding" className="inline-link">
          Run the setup wizard
        </Link>
      </p>
    </main>
  );
}
