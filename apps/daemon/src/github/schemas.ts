import { z } from "zod";

const loginRef = z.object({ login: z.string() });
const labelRef = z.object({ name: z.string() });

export const GhIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  assignees: z.array(loginRef),
  labels: z.array(labelRef),
});

export const GhBlockerSchema = z.object({
  number: z.number().int(),
  state: z.enum(["open", "closed"]),
});

export type GhIssue = {
  number: number;
  title: string;
  url: string;
  assignees: string[];
  labels: string[];
};


export const GhApiCommentSchema = z.object({
  id: z.number().int(),
  user: loginRef.nullable(),
  body: z.string(),
  created_at: z.string(),
});

export type GhComment = {
  id: number;
  author: string | null;
  body: string;
  createdAt: string;
};

// Check runs carry name/status/conclusion; status contexts carry context/state.
const GhCheckSchema = z.object({
  name: z.string().nullable().optional(),
  context: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  conclusion: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
});
type GhCheck = z.infer<typeof GhCheckSchema>;

export type CiStatus = "ok" | "pending" | "failed";

export const GhPrSchema = z.object({
  number: z.number().int(),
  headRefName: z.string(),
  headRefOid: z.string(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  reviewDecision: z
    .string()
    .nullable()
    .transform((v) => (v === "" ? null : v)),
  statusCheckRollup: z.array(GhCheckSchema),
});

export type GhPr = {
  number: number;
  headBranch: string;
  headSha: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: string | null;
  ciStatus: CiStatus;
  failingChecks: string[];
};

export const GhReviewSchema = z.object({
  id: z.number().int(),
  user: loginRef.nullable(),
  state: z.string(),
  submitted_at: z.string().nullable(),
  body: z.string().nullable(),
});
export type GhReviewRaw = z.infer<typeof GhReviewSchema>;

export type GhReview = {
  id: number;
  author: string | null;
  state: string;
  submittedAt: string | null;
  body: string | null;
};

export const GhBodySchema = z.object({ body: z.string().nullable() });

export const GhCommentIdSchema = z.object({ id: z.number().int() });

const PENDING_CONTEXT_STATES = new Set(["PENDING", "EXPECTED"]);

// gh reports a running check run with conclusion "" (or null): done-ness comes
// from status/state, never from conclusion.
function checkDone(check: GhCheck): boolean {
  if (check.state !== undefined && check.state !== null) return !PENDING_CONTEXT_STATES.has(check.state);
  return check.status === "COMPLETED";
}

// Skipped and neutral check runs count as passing, as they do on GitHub.
function checkOk(check: GhCheck): boolean {
  return check.conclusion === "SUCCESS" || check.conclusion === "SKIPPED" || check.conclusion === "NEUTRAL"
    || check.state === "SUCCESS";
}

function checkName(check: GhCheck): string {
  return check.name ?? check.context ?? "unknown check";
}

export function ciRollup(checks: GhCheck[]): { ciStatus: CiStatus; failingChecks: string[] } {
  // An empty rollup maps to "ok": correct for repos with no CI, but right after a push
  // GitHub can briefly report no checks. Callers guarding on "green" must confirm the
  // head SHA is stable across polls, or that the rollup is non-empty for repos with
  // workflows, before treating the PR as green.
  const failing = checks.filter((c) => checkDone(c) && !checkOk(c)).map(checkName);
  const pending = checks.some((c) => !checkDone(c));
  if (failing.length > 0) return { ciStatus: "failed", failingChecks: failing };
  return { ciStatus: pending ? "pending" : "ok", failingChecks: [] };
}

export function toComment(raw: z.infer<typeof GhApiCommentSchema>): GhComment {
  return { id: raw.id, author: raw.user?.login ?? null, body: raw.body, createdAt: raw.created_at };
}

export function toReview(raw: GhReviewRaw): GhReview {
  return {
    id: raw.id,
    author: raw.user?.login ?? null,
    state: raw.state,
    submittedAt: raw.submitted_at,
    body: raw.body,
  };
}

export function commentsSince(all: GhComment[], sinceId: number | undefined): GhComment[] {
  return all
    .filter((c) => sinceId === undefined || c.id > sinceId)
    .sort((a, b) => a.id - b.id);
}
