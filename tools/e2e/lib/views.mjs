/**
 * Views of `/api/sessions`: live/archived access and lookups, all reading
 * the shared SessionView contract (the archived flag lives in the record).
 */

export function live(views) {
  return views.filter((v) => v.session.archivedAt === undefined);
}

export function workerFor(views, issueNumber) {
  return views.find(
    (v) => v.session.persona === "worker" && v.session.issueNumber === issueNumber,
  ) ?? null;
}

/** One compact line per live session, for timeout errors and run output. */
export function lines(views) {
  return live(views).map((v) => {
    const s = v.session;
    return [
      s.id.slice(0, 8),
      s.persona,
      s.issueNumber === undefined ? "" : `issue=${s.issueNumber}`,
      s.prNumber === undefined ? "" : `pr=${s.prNumber}`,
      v.state ?? "no-state",
      `— ${v.status}`,
    ].filter(Boolean).join(" ");
  });
}
