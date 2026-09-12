/**
 * The /sessions/:id pane: live sessions attach the browser terminal as
 * before; archived ones (archivedAt set) render the captured log instead.
 * Both carry the collapsible Trace panel underneath.
 */

import type { Project, SessionView } from "@pideck/shared";
import { Terminal } from "../terminal/Terminal";
import { TracePanel } from "../trace/TracePanel";
import { ArchivedLog } from "./ArchivedLog";

export function SessionPane({ sessionId, views, projects }: {
  sessionId: string;
  views: SessionView[];
  projects: Project[];
}) {
  const view = views.find((candidate) => candidate.session.id === sessionId);
  const pane =
    view === undefined || view.session.archivedAt === undefined ? (
      <Terminal sessionId={sessionId} />
    ) : (
      <ArchivedLog
        sessionId={sessionId}
        view={view}
        project={projects.find((candidate) => candidate.id === view.session.projectId) ?? null}
      />
    );
  return (
    <div className="session-pane">
      {pane}
      <TracePanel sessionId={sessionId} />
    </div>
  );
}
