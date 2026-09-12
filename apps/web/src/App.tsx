import { useCallback, useEffect, useState } from "react";
import type { Project, SessionView } from "@pideck/shared";
import { api, watchSessions } from "./lib/api";
import { navigate, useRoute } from "./router";
import { OnboardingWizard } from "./onboarding/OnboardingWizard";
import { Shell } from "./shell/Shell";
import { rowText } from "./shell/tree";
import { Terminal } from "./terminal/Terminal";
import { Button } from "./ui/Button";
import { Empty } from "./ui/Empty";
import { Toast } from "./ui/Toast";
import { GlobalSettings } from "./settings/GlobalSettings";
import { ProjectSettings } from "./settings/ProjectSettings";

export function App() {
  const route = useRoute();
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [projectList, sessionList] = await Promise.all([api("projectList"), api("sessionList")]);
      setProjects(projectList);
      setSessions(sessionList);
      setLoadError(null);
    } catch {
      setLoadError("Cannot reach the daemon.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    return watchSessions((views) => setSessions(views));
  }, [load]);

  const onChanged = useCallback(() => {
    void load();
  }, [load]);
  const onNavigate = useCallback((path: string) => navigate(path), []);
  const onToast = useCallback((message: string) => setToast(message), []);
  const onDismissToast = useCallback(() => setToast(null), []);
  const retry = useCallback(() => {
    void load();
  }, [load]);

  const context = (() => {
    switch (route.name) {
      case "home":
        return null;
      case "onboarding":
        return "Onboarding";
      case "settings":
        return "Settings";
      case "projectSettings": {
        const project = projects.find((candidate) => candidate.id === route.id);
        return project === undefined ? "Project settings" : `${project.name} › Settings`;
      }
      case "session": {
        const view = sessions.find((candidate) => candidate.session.id === route.id);
        if (view === undefined) return "Session";
        const project = projects.find((candidate) => candidate.id === view.session.projectId);
        return project === undefined ? rowText(view) : `${project.name} › ${rowText(view)}`;
      }
    }
  })();

  const home = (() => {
    if (!loaded) return <Empty>Connecting to the daemon…</Empty>;
    if (loadError !== null) {
      return (
        <Empty action={<Button variant="primary" onClick={retry}>Retry</Button>}>{loadError}</Empty>
      );
    }
    if (projects.length === 0) {
      return (
        <Empty action={<Button variant="primary" onClick={() => navigate("/onboarding")}>Add project</Button>}>
          No projects yet.
        </Empty>
      );
    }
    return <Empty>Select a session from the sidebar.</Empty>;
  })();

  const content = (() => {
    switch (route.name) {
      case "session":
        return <Terminal sessionId={route.id} />;
      case "onboarding":
        return <OnboardingWizard onDone={() => navigate("/")} />;
      case "settings":
        return <GlobalSettings />;
      case "projectSettings":
        return <ProjectSettings projectId={route.id} />;
      case "home":
        return home;
    }
  })();

  return (
    <>
      <Shell
        route={route}
        context={context}
        projects={projects}
        sessions={sessions}
        selectedId={route.name === "session" ? route.id : null}
        onNavigate={onNavigate}
        onChanged={onChanged}
        onToast={onToast}
        fill={route.name === "session"}
      >
        {content}
      </Shell>
      <Toast message={toast} onDismiss={onDismissToast} />
    </>
  );
}
