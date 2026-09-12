/**
 * One project's settings page: the five loop knobs in a single section, plus
 * a danger section that deletes the project after naming it in a confirm
 * dialog. Values are validated against the shared ProjectSettingsSchema
 * before the PUT goes out.
 */

import { useEffect, useState } from "react";
import { errorMessage, ProjectSettingsSchema, type Project, type ProjectSettings } from "@pideck/shared";
import { Page } from "../ui/Page";
import { Section } from "../ui/Section";
import { Row } from "../ui/Row";
import { Field } from "../ui/Field";
import { Switch } from "../ui/Switch";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Empty } from "../ui/Empty";
import {
  deleteProject,
  loadProject,
  loadProjectSessions,
  loadProjectSettings,
  saveProjectSettings,
} from "./client";
import { actionLabel, useAction } from "./use-action";

export function ProjectSettings({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [reviewAccess, setReviewAccess] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workerConcurrency, setWorkerConcurrency] = useState("");
  const [maxFixAttempts, setMaxFixAttempts] = useState("");
  const [contextLimitPercent, setContextLimitPercent] = useState("");
  const [stallMinutes, setStallMinutes] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const save = useAction();
  const destroy = useAction();

  useEffect(() => {
    let alive = true;
    Promise.all([loadProject(projectId), loadProjectSettings(projectId), loadProjectSessions(projectId)])
      .then(([loadedProject, loadedSettings, loadedSessions]) => {
        if (!alive) return;
        setProject(loadedProject);
        setSettings(loadedSettings);
        setReviewAccess(loadedSessions.find((view) => view.reviewAccess !== null)?.reviewAccess ?? null);
        apply(loadedSettings);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const apply = (values: ProjectSettings) => {
    setWorkerConcurrency(String(values.workerConcurrency));
    setMaxFixAttempts(String(values.maxFixAttempts));
    setContextLimitPercent(String(values.contextLimitPercent));
    setStallMinutes(String(values.stallMinutes));
    setAutoMerge(values.autoMerge);
  };

  const onSave = () => {
    setFieldErrors({});
    const candidate = {
      workerConcurrency: Number(workerConcurrency),
      maxFixAttempts: Number(maxFixAttempts),
      contextLimitPercent: Number(contextLimitPercent),
      stallMinutes: Number(stallMinutes),
      autoMerge,
    };
    const parsed = ProjectSettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      const errors: Partial<Record<string, string>> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join(".");
        if (path && errors[path] === undefined) errors[path] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    void save.run(async () => {
      const saved = await saveProjectSettings(projectId, parsed.data);
      setSettings(saved);
      apply(saved);
    });
  };

  const onDelete = () => {
    setConfirmDelete(false);
    void destroy.run(async () => {
      await deleteProject(projectId);
      setDeleted(true);
    });
  };

  if (deleted) {
    return (
      <Page title="Project settings">
        <Empty>The project was deleted.</Empty>
      </Page>
    );
  }

  const name = project?.name ?? "this project";

  return (
    <Page title={project ? `${name} settings` : "Project settings"}>
      {reviewAccess !== null && (
        <p style={{ color: "var(--red)", margin: "0 0 16px" }} role="status">
          {reviewAccess} — no reviewer will run until it is fixed.
        </p>
      )}
      {loadError && <p style={{ color: "var(--red)", margin: "0 0 16px" }}>Settings could not be loaded: {loadError}</p>}
      <Section
        title="Settings"
        description="Knobs for this project's loop. They apply from the next reconciliation."
        footer={
          <>
            {save.error && <p style={{ color: "var(--red)", margin: 0 }}>{save.error}</p>}
            <Button
              variant="primary"
              disabled={save.state === "busy" || !settings}
              onClick={onSave}
            >
              {actionLabel(save.state, "Save", "Saving…")}
            </Button>
          </>
        }
      >
        <Row label="Worker concurrency" description="Maximum workers running at once for this project. Default 3.">
          <Field
            type="number"
            min={1}
            value={workerConcurrency}
            onChange={setWorkerConcurrency}
            error={fieldErrors.workerConcurrency}
            label="Worker concurrency"
          />
        </Row>
        <Row
          label="Max fix attempts"
          description="CI/review fix rounds before the worker reports back and goes idle. Default 5."
        >
          <Field
            type="number"
            min={1}
            value={maxFixAttempts}
            onChange={setMaxFixAttempts}
            error={fieldErrors.maxFixAttempts}
            label="Max fix attempts"
          />
        </Row>
        <Row label="Context limit" description="Percent of context usage that replaces a session. Default 30.">
          <Field
            type="number"
            min={1}
            max={100}
            value={contextLimitPercent}
            onChange={setContextLimitPercent}
            error={fieldErrors.contextLimitPercent}
            label="Context limit percent"
          />
        </Row>
        <Row label="Stall minutes" description="Silence for this long steers the orchestrator to check on the worker. Default 45 minutes.">
          <Field
            type="number"
            min={1}
            value={stallMinutes}
            onChange={setStallMinutes}
            error={fieldErrors.stallMinutes}
            label="Stall minutes"
          />
        </Row>
        <Row
          label="Auto-merge"
          description="Merge approved, green PRs automatically; otherwise recommend the merge. Default off."
        >
          <Switch checked={autoMerge} onChange={setAutoMerge} label="Auto-merge" />
        </Row>
      </Section>
      <Section
        title="Danger"
        description={`Deleting ${name} removes its settings and sessions. GitHub issues and PRs are untouched.`}
        footer={
          <>
            {destroy.error && <p style={{ color: "var(--red)", margin: 0 }}>{destroy.error}</p>}
            <Button
              variant="danger"
              disabled={destroy.state === "busy" || !project}
              onClick={() => setConfirmDelete(true)}
            >
              {actionLabel(destroy.state, "Delete project", "Deleting…", "Deleted")}
            </Button>
          </>
        }
      >
        <Row label="Repo" description="Unaffected on GitHub.">
          <span style={{ color: "var(--text-dim)", overflowWrap: "anywhere" }}>
            {project ? `${project.owner}/${project.repo}` : "…"}
          </span>
        </Row>
      </Section>
      <Dialog
        open={confirmDelete}
        title={`Delete project ${name}?`}
        confirmLabel="Delete"
        danger
        onConfirm={onDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </Page>
  );
}