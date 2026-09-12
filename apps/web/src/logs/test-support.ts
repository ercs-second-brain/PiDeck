import { SessionViewSchema, type SessionView } from "@pideck/shared";

/** A SessionView built through the shared contract; override fields per case. */
export function makeView(overrides: Partial<SessionView["session"]> = {}): SessionView {
  const clean = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return SessionViewSchema.parse({
    session: {
      id: "s1",
      persona: "worker",
      projectId: "p1",
      tmuxSession: "pideck-s1",
      spawnedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      model: null,
      ...clean,
    },
    state: "done",
    status: "archived",
    parentSessionId: null,
    title: null,
  });
}