import type { Project, Session } from "@pideck/shared";

export interface BriefingIssue {
  number: number;
  title: string;
  blocked: boolean;
  assignee: string | null;
}

export interface BriefingPr {
  number: number;
  issueNumber: number | null;
  ci: "green" | "red" | "pending";
  review: "approved" | "changes_requested" | "pending";
}

export interface BriefingData {
  project: Project;
  issues: BriefingIssue[];
  prs: BriefingPr[];
  sessions: Session[];
}

export function buildBriefing(data: BriefingData): string {
  const assigned: string[] = [];
  const blocked: string[] = [];
  const unassigned: string[] = [];
  for (const issue of data.issues) {
    const label = `#${issue.number} ${issue.title}`;
    if (issue.blocked) blocked.push(label);
    else if (issue.assignee) assigned.push(label);
    else unassigned.push(label);
  }
  const prs = data.prs.map(
    (pr) => `#${pr.number}${pr.issueNumber ? ` for #${pr.issueNumber}` : ""} CI ${pr.ci}, review ${pr.review}`,
  );
  const sessions = data.sessions.map((session) => {
    const work = session.issueNumber
      ? ` #${session.issueNumber}`
      : session.prNumber
        ? ` PR #${session.prNumber}`
        : "";
    return `${session.persona}${work} (${session.id})`;
  });
  const groups: string[] = [];
  if (data.issues.length === 0) {
    groups.push("no open issues");
  } else {
    for (const part of [
      group("assigned", assigned),
      group("blocked", blocked),
      group("unassigned", unassigned),
    ]) {
      if (part !== null) groups.push(part);
    }
  }
  groups.push(prs.length ? `PRs: ${prs.join(", ")}` : "no open PRs");
  groups.push(sessions.length ? `live: ${sessions.join(", ")}` : "no live sessions");
  groups.push(`project memory: docs/ on ${data.project.defaultBranch}`);
  const { name, owner, repo, defaultBranch } = data.project;
  return `Briefing for ${name} (${owner}/${repo}, branch ${defaultBranch}): ${groups.join("; ")}.`;
}

function group(label: string, items: string[]): string | null {
  return items.length ? `${label}: ${items.join(", ")}` : null;
}