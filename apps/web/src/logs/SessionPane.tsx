/**
 * The /sessions/:id pane: live sessions attach the browser terminal as
 * before; archived ones (archivedAt set) render the captured log instead.
 */

import type { Project, SessionView } from "@pideck/shared";
import { Terminal } from "../terminal/Terminal";
import { ArchivedLog } from "./ArchivedLog";

export function SessionPane({ sessionId, views, projects }: {
  sessionId: string;
  views: SessionView[];
  projects: Project[];
}) {
  const view = views.find((candidate) => candidate.session.id === sessionId);
  if (view === undefined || view.session.archivedAt === undefined) {
    return <Terminal sessionId={sessionId} />;
  }
  const project = projects.find((candidate) => candidate.id === view.session.projectId) ?? null;
  return <ArchivedLog sessionId={sessionId} view={view} project={project} />;
}