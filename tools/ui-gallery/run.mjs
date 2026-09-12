#!/usr/bin/env node
// pnpm ui-gallery — a viewing gallery of every PiDeck screen and state.
//
// Boots the real daemon against the fake gh (tools/fake-gh) and a fake tmux,
// seeds a realistic state — workers in all eight states, a reviewer nested
// under its worker, an archived session with captured log and trace, the
// global agent, an update available, a configured review account, and one
// prompt override — then drives headless Playwright through every route at
// 1280×800 and 390×844 and writes runs/ui/<timestamp>/index.html plus
// manifest.json. `--assert` additionally runs the layout assertions as a
// Playwright test (tools/ui-gallery/assert.spec.mjs).
//
// Not part of CI (needs Chromium); a run takes well under two minutes.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOL_DIR, "..", "..");
const DAEMON_ENTRY = join(ROOT, "apps", "daemon", "dist", "index.js");
const WEB_DIST = join(ROOT, "apps", "web", "dist");
const FAKE_GH = join(ROOT, "tools", "fake-gh", "gh");

const assertMode = process.argv.includes("--assert");
const keepTemp = process.argv.includes("--keep");

const startedAt = Date.now();
const outDir = join(
  ROOT,
  "runs",
  "ui",
  new Date(startedAt).toISOString().replaceAll(":", "-").split(".")[0],
);
mkdirSync(outDir, { recursive: true });

const REVIEW_TOKEN = "tok-gallery-review-not-a-secret";

// ---------------------------------------------------------------------------
// Fake binaries on the daemon's PATH

/** A tmux stand-in: sessions are directories under TMUX_FAKE_STATE; panes
 *  always look settled, so the daemon's readiness wait returns immediately. */
function fakeTmuxScript() {
  return `#!/bin/sh
STATE="\${TMUX_FAKE_STATE:?TMUX_FAKE_STATE is not set}"
cmd="$1"; shift
case "$cmd" in
  -V)
    echo "tmux 3.4-fake"
    ;;
  new-session)
    name=""; win="worker"
    while [ $# -gt 0 ]; do
      case "$1" in
        -s) name="$2"; shift ;;
        -n) win="$2"; shift ;;
      esac
      shift
    done
    mkdir -p "$STATE/$name"
    printf '%s' "$win" > "$STATE/$name/window"
    ;;
  has-session)
    name=""
    while [ $# -gt 0 ]; do case "$1" in -t) name="$2"; shift ;; esac; shift; done
    [ -d "$STATE/$name" ] || { echo "no such session" >&2; exit 1; }
    ;;
  list-sessions)
    for dir in "$STATE"/*/; do [ -d "$dir" ] && basename "$dir"; done
    ;;
  kill-session)
    name=""
    while [ $# -gt 0 ]; do case "$1" in -t) name="$2"; shift ;; esac; shift; done
    rm -rf "$STATE/$name"
    ;;
  capture-pane)
    name=""
    while [ $# -gt 0 ]; do case "$1" in -t) name="$2"; shift ;; esac; shift; done
    persona=$(cat "$STATE/$name/window" 2>/dev/null || echo worker)
    printf 'pi \\033[1;33mv0.4.2\\033[0m \\xe2\\x80\\xa2 %s\\n' "$persona"
    printf '\\n'
    printf '\\033[2mWorking on the assigned issue — reading the repo\\xe2\\x80\\xa6\\033[0m\\n'
    printf '\\n'
    printf '\\033[36m\\xe2\\x9d\\xaf\\033[0m '
    ;;
  *)
    ;;
esac
`;
}

function installFakeBins(temp) {
  const bin = join(temp, "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(FAKE_GH, join(bin, "gh"));
  chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(bin, "tmux"), fakeTmuxScript(), "utf8");
  chmodSync(join(bin, "tmux"), 0o755);
  // The shim the updater spawns when the pill is clicked; a no-op keeps the
  // daemon alive so the "Updating…" pill state can be captured.
  mkdirSync(join(temp, "state", "bin"), { recursive: true });
  writeFileSync(join(temp, "state", "bin", "pideck"), "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(join(temp, "state", "bin", "pideck"), 0o755);
}

// ---------------------------------------------------------------------------
// Seeded state

const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const REPO_PIDECK = "acme/pideck";
const projects = {
  "my-api": { owner: "acme", repo: "my-api" },
  "my-web": { owner: "acme", repo: "my-web" },
};

const repoSpecs = {
  "acme/my-api": {
    issues: [
      { number: 31, title: "Drop the legacy token format", state: "closed" },
      { number: 42, title: "Fix flaky auth refresh test", state: "open" },
      { number: 47, title: "Add rate limiting to the ingest API", state: "open" },
      { number: 51, title: "Paginate the events endpoint", state: "open" },
      { number: 63, title: "Stream the log tail over WebSocket", state: "open" },
    ],
    prs: [
      { number: 15, issue: 31, sha: "a15a15a15a", ci: "ok", state: "merged" },
      { number: 142, issue: 42, sha: "c42c42c42c", ci: "failed", failing: ["ci / unit"] },
      { number: 171, issue: 63, sha: "d63d63d63d", ci: "ok" },
      { number: 561, issue: 51, sha: "b51b51b51b", ci: "pending" },
    ],
  },
  "acme/my-web": {
    issues: [
      { number: 55, title: "Polish the dashboard empty states", state: "open" },
      { number: 70, title: "Ship the dark mode token set", state: "open" },
      { number: 90, title: "Fix the mobile keyboard viewport jump", state: "open" },
    ],
    prs: [
      { number: 159, issue: 55, sha: "e55e55e55e", ci: "ok", reviews: ["CHANGES_REQUESTED"] },
      { number: 188, issue: 70, sha: "f70f70f70f", ci: "ok", reviews: ["CHANGES_REQUESTED", "APPROVED"] },
      { number: 299, issue: 90, sha: "0299029902", ci: "failed", failing: ["e2e / mobile"] },
    ],
  },
  [REPO_PIDECK]: {
    issues: [],
    prs: [],
    upstreamSha: "c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffee",
  },
};

function checksFor(ci, failing) {
  if (ci === "failed") {
    return (failing ?? ["ci"]).map((name) => ({ name, status: "COMPLETED", conclusion: "FAILURE" }));
  }
  if (ci === "pending") return [{ name: "ci", status: "IN_PROGRESS", state: "PENDING" }];
  return [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
}

function fakeGhState() {
  const repos = {};
  for (const [name, spec] of Object.entries(repoSpecs)) {
    repos[name] = {
      issues: spec.issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: `https://github.com/${name}/issues/${issue.number}`,
        state: issue.state,
        assignees: issue.state === "open" ? ["acme-dev"] : [],
        labels: [],
        blockedBy: [],
      })),
      comments: {
        47: [{ id: 501, user: "acme-dev", body: "Scope note: limit this to the ingest endpoints.", created_at: ago(2 * HOUR) }],
      },
      prs: spec.prs.map((pr, index) => ({
        number: pr.number,
        headRefName: `pideck/issue-${pr.issue}`,
        headRefOid: pr.sha,
        mergeable: "MERGEABLE",
        checks: checksFor(pr.ci, pr.failing),
        reviews: (pr.reviews ?? []).map((state, i) => ({
          id: 520 + index * 10 + i,
          user: "acme-review",
          state,
          submitted_at: ago(30 * MINUTE),
          body: null,
        })),
        reviewComments: [],
        requestedReviewers: [],
        body: `Closes #${pr.issue}`,
        state: pr.state ?? "open",
      })),
      upstreamSha: spec.upstreamSha ?? null,
    };
  }
  return {
    seq: 1000,
    primaryLogin: "acme-dev",
    tokens: { [REVIEW_TOKEN]: "acme-review" },
    repos,
    invitations: [],
    readAccess: {},
  };
}

/** One session per worker state (one archived), plus reviewer, orchestrators, global. */
function sessionRecords() {
  const records = [
    {
      id: "global",
      persona: "global",
      projectId: null,
      tmuxSession: "pideck-gallery-global",
      spawnedAt: ago(3 * DAY),
      model: null,
    },
  ];
  for (const id of Object.keys(projects)) {
    records.push({
      id: `orch-${id}`,
      persona: "orchestrator",
      projectId: id,
      tmuxSession: `pideck-gallery-orch-${id}`,
      spawnedAt: ago(3 * DAY),
      model: null,
    });
  }
  const workers = [
    { state: "working", id: "w-working", project: "my-api", issue: 47, extra: { lastDeliveredIssueCommentId: 501, lastActivityAt: ago(5 * MINUTE) } },
    { state: "ci", id: "w-ci", project: "my-api", issue: 51, pr: 561, sha: "b51b51b51b" },
    { state: "fixing", id: "w-fixing", project: "my-api", issue: 42, pr: 142, sha: "c42c42c42c", extra: { fixAttempts: 1 } },
    { state: "in_review", id: "w-in-review", project: "my-api", issue: 63, pr: 171, sha: "d63d63d63d" },
    { state: "addressing", id: "w-addressing", project: "my-web", issue: 55, pr: 159, sha: "e55e55e55e", extra: { lastDeliveredReviewId: 520, lastActivityAt: ago(40 * MINUTE) } },
    { state: "ready", id: "w-ready", project: "my-web", issue: 70, pr: 188, sha: "f70f70f70f", extra: { lastDeliveredReviewId: 531 } },
    { state: "blocked", id: "w-blocked", project: "my-web", issue: 90, pr: 299, sha: "0299029902", extra: { fixAttempts: 5 } },
    {
      state: "done",
      id: "w-archived",
      project: "my-api",
      issue: 31,
      pr: 15,
      sha: "a15a15a15a",
      archived: true,
      extra: { archivedAt: ago(26 * HOUR), lastActivityAt: ago(27 * HOUR) },
    },
  ];
  for (const w of workers) {
    records.push({
      id: w.id,
      persona: "worker",
      projectId: w.project,
      issueNumber: w.issue,
      prNumber: w.pr,
      tmuxSession: `pideck-gallery-${w.state}`,
      spawnedAt: ago(w.archived === true ? 3 * DAY : HOUR),
      model: null,
      lastPromptedHeadSha: w.sha,
      ...w.extra,
    });
  }
  records.push({
    id: "rev-171",
    persona: "reviewer",
    projectId: "my-api",
    prNumber: 171,
    tmuxSession: "pideck-gallery-reviewer",
    spawnedAt: ago(25 * MINUTE),
    model: null,
    lastPromptedHeadSha: "d63d63d63d",
  });
  return records;
}

const ARCHIVED_LOG = [
  "pi \x1b[1;33mv0.4.2\x1b[0m \x1b[2m·\x1b[0m worker",
  "",
  "\x1b[36m❯\x1b[0m \x1b[2mWorker session for issue #31 — work on branch pideck/issue-31\x1b[0m",
  "",
  "  Reading the legacy token paths…",
  "  \x1b[32m✔\x1b[0m removed the v1 verifier and its tests",
  "  \x1b[32m✔\x1b[0m migrated the stored sessions",
  "  pushed pideck/issue-31 → \x1b[2ma15a15a\x1b[0m",
  "",
  "  \x1b[32m✔\x1b[0m opened PR #15 with \"Closes #31\"",
  "",
].join("\n");

const ARCHIVED_TRACE = [
  { at: ago(3 * DAY), kind: "spawn", detail: "spawned worker for issue #31" },
  {
    at: ago(3 * DAY),
    kind: "delivery",
    text:
      'Worker session for issue #31 "Drop the legacy token format" — work on branch pideck/issue-31, ' +
      'open one PR with "Closes #31" in the body. https://github.com/acme/my-api/issues/31',
  },
  { at: ago(2 * DAY), kind: "state", from: "working", to: "in_review", status: "awaiting review on PR #15" },
  { at: ago(2 * DAY), kind: "facts", facts: { issueNumber: 31, prNumber: 15, headSha: "a15a15a15a", ci: "ok" } },
  { at: ago(26 * HOUR), kind: "archive", detail: "PR #15 merged or closed" },
];

/** Writes the whole PD_HOME: stores, logs, trace, config, clone repos, panes. */
function seedState(stateDir, tmuxStateDir) {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });

  const projectList = Object.entries(projects).map(([id, spec]) => {
    const path = join(stateDir, "clones", id);
    run("git", ["init", "-q", "-b", "main", path]);
    run("git", [
      "-C", path,
      "-c", "user.email=gallery@example.com",
      "-c", "user.name=Gallery",
      "commit", "--allow-empty", "-qm", "seed",
    ]);
    return {
      project: {
        id,
        name: id,
        repoUrl: `https://github.com/${spec.owner}/${spec.repo}`,
        owner: spec.owner,
        repo: spec.repo,
        defaultBranch: "main",
        path,
      },
      settings: {
        workerConcurrency: 3,
        maxFixAttempts: 5,
        contextLimitPercent: 80,
        stallMinutes: 20,
        autoMerge: false,
      },
    };
  });
  writeFileSync(join(stateDir, "projects.json"), JSON.stringify({ projects: projectList }, null, 2));
  writeFileSync(join(stateDir, "sessions.json"), JSON.stringify(sessionRecords(), null, 2));
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify(
      {
        reviewAccount: { username: "acme-review", token: REVIEW_TOKEN },
        modelByPersona: { global: null, orchestrator: null, worker: null, reviewer: null },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(stateDir, "prompts.json"),
    JSON.stringify(
      {
        worker:
          "# Worker (gallery override)\n\nImplement the assigned issue end to end. Work on " +
          "`pideck/issue-<n>` and open exactly one PR with `Closes #<n>` in the body.\n",
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ repoUrl: `https://github.com/${REPO_PIDECK}`, repoRef: "main" }, null, 2),
  );

  mkdirSync(join(stateDir, "logs"), { recursive: true });
  writeFileSync(join(stateDir, "logs", "w-archived.log"), `${ARCHIVED_LOG}\n`);
  mkdirSync(join(stateDir, "traces"), { recursive: true });
  writeFileSync(
    join(stateDir, "traces", "w-archived.jsonl"),
    `${ARCHIVED_TRACE.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );

  for (const record of sessionRecords()) {
    const dir = join(tmuxStateDir, record.tmuxSession);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "window"), record.persona, "utf8");
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Daemon lifecycle

function startDaemon(env) {
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[daemon] ${chunk}`);
  });
  return { child, stdout: () => stdout };
}

async function waitUntil(fn, { timeoutMs = 30_000, everyMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }
}

async function daemonPort(daemon) {
  return waitUntil(
    () => {
      const match = daemon.stdout().match(/\[daemon\] listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match === null) throw new Error("not listening yet");
      return Number(match[1]);
    },
    { label: "the daemon to listen" },
  );
}

async function waitForDaemon(port) {
  await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    if (!response.ok) throw new Error("not ready");
    return true;
  }, { label: "the daemon to answer /api/status" });
}

async function stopDaemon(daemon) {
  daemon.child.kill("SIGTERM");
  await waitUntil(() => (daemon.child.exitCode !== null ? true : Promise.reject(new Error("running"))), {
    label: "the daemon to exit",
  });
}

async function api(port, path, options) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  if (!response.ok) throw new Error(`${options?.method ?? "GET"} ${path} failed: ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------------
// The shot list

const DESIGN = {
  empty: "§5 Empty states",
  sidebar: "§3 Sidebar",
  layout: "§3 Layout",
  terminal: "§2 Terminal",
  log: "§5 Log viewer",
  onboarding: "§5 Onboarding",
  settings: "§5 Settings",
  prompts: "§5 Settings · Prompts",
  projectSettings: "§5 Project settings",
  dialog: "§6 Interaction rules",
  header: "§3 Header",
  mobile: "§3 Layout (mobile)",
};

/** Shot descriptors: name, rubric section, viewport, state, route, and the
 *  interactions that put the page into the shot's state. */
function buildShots(sessionId) {
  const shots = [
    {
      name: "home-empty",
      design: DESIGN.empty,
      viewport: "desktop",
      state: "no projects yet",
      route: "/",
      async run(page) {
        await page.goto("/");
        await page.getByText("No projects yet.").waitFor();
      },
    },
    {
      name: "home-empty-mobile",
      design: DESIGN.empty,
      viewport: "mobile",
      state: "no projects yet — the sidebar is the home screen",
      route: "/",
      async run(page) {
        await page.goto("/");
        await page.getByText("+ Add project").waitFor();
      },
    },
    {
      name: "home-populated",
      design: DESIGN.sidebar,
      viewport: "desktop",
      state: "two projects, workers in all eight states",
      route: "/",
      async run(page) {
        await page.goto("/");
        await page.getByText("#47").waitFor();
      },
    },
    {
      name: "sidebar-collapsed",
      design: DESIGN.layout,
      viewport: "desktop",
      state: "sidebar hidden via the header toggle",
      route: "/",
      async run(page) {
        await page.locator(".header__toggle").click();
        await page.locator(".shell--collapsed").waitFor();
      },
    },
    ...[
      ["working", "worker state: working"],
      ["ci", "worker state: ci"],
      ["fixing", "worker state: fixing"],
      ["in_review", "worker state: in review"],
      ["addressing", "worker state: addressing"],
      ["ready", "worker state: ready"],
      ["blocked", "worker state: blocked"],
    ].map(([state, label]) => ({
      name: `session-worker-${state}`,
      design: DESIGN.terminal,
      viewport: "desktop",
      state: label,
      route: "/sessions/:id",
      async run(page) {
        await page.goto(`/sessions/${sessionId[state]}`);
        await page.locator(".xterm-screen").first().waitFor();
        await page.waitForTimeout(400);
      },
    })),
    {
      name: "session-reviewer",
      design: DESIGN.terminal,
      viewport: "desktop",
      state: "the reviewer attached to PR #171",
      route: "/sessions/:id",
      async run(page) {
        await page.goto(`/sessions/${sessionId.reviewer}`);
        await page.locator(".xterm-screen").first().waitFor();
        await page.waitForTimeout(400);
      },
    },
    {
      name: "session-global",
      design: DESIGN.terminal,
      viewport: "desktop",
      state: "the global agent",
      route: "/sessions/:id",
      async run(page) {
        await page.goto(`/sessions/${sessionId.global}`);
        await page.locator(".xterm-screen").first().waitFor();
        await page.waitForTimeout(400);
      },
    },
    {
      name: "session-archived-log",
      design: DESIGN.log,
      viewport: "desktop",
      state: "archived session: captured log + trace panel",
      route: "/sessions/:id",
      async run(page) {
        await page.goto(`/sessions/${sessionId.archived}`);
        await page.locator(".xterm-screen").first().waitFor();
        await page.locator(".trace__toggle").click();
        await page.locator(".trace__list").waitFor();
        await page.waitForTimeout(300);
      },
    },
    {
      name: "onboarding-repo",
      design: DESIGN.onboarding,
      viewport: "desktop",
      state: "re-entry with prerequisites met: repo step",
      route: "/onboarding",
      async run(page) {
        await page.goto("/onboarding");
        await page.getByText("Project repository").waitFor();
      },
    },
    {
      name: "onboarding-pi",
      design: DESIGN.onboarding,
      viewport: "desktop",
      state: "step 1: pi probe",
      route: "/onboarding",
      async run(page) {
        await page.goto("/onboarding");
        await page.getByText("Re-check").waitFor();
        await page.waitForTimeout(300);
      },
    },
    {
      name: "onboarding-github",
      design: DESIGN.onboarding,
      viewport: "desktop",
      state: "step 2: GitHub probe",
      route: "/onboarding",
      async run(page) {
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByText("Re-check").waitFor();
        await page.waitForTimeout(500);
      },
    },
    {
      name: "onboarding-review",
      design: DESIGN.onboarding,
      viewport: "desktop",
      state: "step 3: review account verified",
      route: "/onboarding",
      async run(page) {
        await page.getByRole("button", { name: "Next" }).click();
        await page.getByLabel("Username").fill("acme-review");
        await page.getByLabel("Personal access token").fill(REVIEW_TOKEN);
        await page.getByRole("button", { name: "Verify" }).click();
        await page.getByText("Verified as").waitFor();
      },
    },
    {
      name: "settings-general",
      design: DESIGN.settings,
      viewport: "desktop",
      state: "general sub-page",
      route: "/settings",
      async run(page) {
        await page.goto("/settings");
        await page.getByText("Poll interval").waitFor();
      },
    },
    {
      name: "settings-account",
      design: DESIGN.settings,
      viewport: "desktop",
      state: "review account sub-page",
      route: "/settings",
      async run(page) {
        await page.getByRole("button", { name: "Review account" }).click();
        await page.waitForTimeout(300);
      },
    },
    {
      name: "settings-models",
      design: DESIGN.settings,
      viewport: "desktop",
      state: "models sub-page",
      route: "/settings",
      async run(page) {
        await page.getByRole("button", { name: "Models" }).click();
        await page.waitForTimeout(300);
      },
    },
    {
      name: "settings-prompts",
      design: DESIGN.prompts,
      viewport: "desktop",
      state: "prompt editor, shipped prompt",
      route: "/settings",
      async run(page) {
        await page.getByRole("button", { name: "Prompts" }).click();
        await page.locator("textarea").waitFor();
        await page.waitForTimeout(300);
      },
    },
    {
      name: "prompt-editor-edited",
      design: DESIGN.prompts,
      viewport: "desktop",
      state: "prompt editor, edited override",
      route: "/settings",
      async run(page) {
        await page.getByRole("tab", { name: "Worker" }).click();
        await page.getByText("Edited").first().waitFor();
      },
    },
    {
      name: "project-settings",
      design: DESIGN.projectSettings,
      viewport: "desktop",
      state: "the five loop knobs",
      route: "/projects/:id/settings",
      async run(page) {
        await page.goto("/projects/my-api/settings");
        await page.getByText("Worker concurrency").waitFor();
      },
    },
    {
      name: "project-menu-open",
      design: DESIGN.sidebar,
      viewport: "desktop",
      state: "project ⋯ menu open",
      route: "/",
      async run(page) {
        await page.goto("/");
        await page.getByText("#47").waitFor();
        await page.locator('[aria-label="Actions for my-api"]').click();
        await page.locator(".srow-menu").waitFor();
      },
    },
    {
      name: "terminate-dialog",
      design: DESIGN.dialog,
      viewport: "desktop",
      state: "terminate confirmation dialog",
      route: "/",
      async run(page) {
        await page.keyboard.press("Escape");
        await page.locator('[aria-label^="Actions for #47"]').click();
        await page.getByRole("menuitem", { name: "Terminate" }).click();
        await page.getByText("Terminate the worker for #47?").waitFor();
        await page.keyboard.press("Escape");
      },
    },
    {
      name: "update-pill-agents-live",
      design: DESIGN.header,
      viewport: "desktop",
      state: "update pill: agents live, the update waits",
      route: "/",
      async run(page) {
        await page.goto("/");
        await page.getByText("agents are live").waitFor();
      },
    },
    {
      name: "mobile-home",
      design: DESIGN.mobile,
      viewport: "mobile",
      state: "the sidebar is the home screen",
      route: "/",
      async run(page) {
        await page.goto("/");
        await page.getByText("#47").waitFor();
      },
    },
    {
      name: "mobile-session",
      design: DESIGN.mobile,
      viewport: "mobile",
      state: "list → session: terminal, key row, composer",
      route: "/sessions/:id",
      async run(page) {
        await page.locator(".srow", { hasText: "#47" }).click();
        await page.locator(".xterm-screen").first().waitFor();
        await page.waitForTimeout(400);
      },
    },
    {
      name: "mobile-back",
      design: DESIGN.mobile,
      viewport: "mobile",
      state: "browser back returns to the list",
      route: "/",
      async run(page) {
        await page.goBack();
        await page.getByText("#47").waitFor();
      },
    },
    {
      name: "update-pill-available",
      design: DESIGN.header,
      viewport: "desktop",
      state: "update pill: no live agents",
      route: "/",
      async run(page) {
        await page.reload();
        await page.getByRole("button", { name: "Update" }).waitFor();
      },
    },
    {
      name: "update-pill-updating",
      design: DESIGN.header,
      viewport: "desktop",
      state: "update pill: applying the update",
      route: "/",
      async run(page) {
        await page.getByRole("button", { name: "Update" }).click();
        await page.getByText("Updating…").waitFor();
      },
    },
  ];
  return shots;
}

const DESKTOP_ORDER = [
  "home-populated",
  "sidebar-collapsed",
  "session-worker-working",
  "session-worker-ci",
  "session-worker-fixing",
  "session-worker-in-review",
  "session-worker-addressing",
  "session-worker-ready",
  "session-worker-blocked",
  "session-reviewer",
  "session-global",
  "session-archived-log",
  "onboarding-repo",
  "onboarding-pi",
  "onboarding-github",
  "onboarding-review",
  "settings-general",
  "settings-account",
  "settings-models",
  "settings-prompts",
  "prompt-editor-edited",
  "project-settings",
  "project-menu-open",
  "terminate-dialog",
  "update-pill-agents-live",
  "mobile-home",
  "mobile-session",
  "mobile-back",
  "update-pill-available",
  "update-pill-updating",
];

function routesForAssertions() {
  return [
    { path: "/", name: "home" },
    { path: "/sessions/w-working", name: "session (live worker)" },
    { path: "/sessions/rev-171", name: "session (reviewer)" },
    { path: "/sessions/w-archived", name: "session (archived log)" },
    { path: "/onboarding", name: "onboarding" },
    { path: "/settings", name: "settings" },
    { path: "/projects/my-api/settings", name: "project settings" },
  ];
}

// ---------------------------------------------------------------------------
// Gallery output

function writeGallery(shots, assertionSummary) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    command: "pnpm ui-gallery",
    rubric: "docs/DESIGN.md",
    durationMs: Date.now() - startedAt,
    assertions: assertionSummary,
    shots: shots.map(({ name, design, viewport, state, route }) => ({
      name,
      design,
      viewport,
      state,
      route,
      file: `${name}.png`,
    })),
  };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const cards = shots
    .map(
      (shot) => `      <figure>
        <a href="${shot.name}.png" target="_blank" rel="noreferrer"><img src="${shot.name}.png" alt="${shot.name}" loading="lazy"></a>
        <figcaption>
          <span class="name">${shot.route}</span>
          <span class="meta">${shot.viewport} · ${shot.state}</span>
          <span class="design">judge against DESIGN.md ${shot.design}</span>
        </figcaption>
      </figure>`,
    )
    .join("\n");
  const assertion = (() => {
    if (assertionSummary === null) return "";
    return assertionSummary.ok
      ? '<div class="assert pass">layout assertions: all passed</div>'
      : `<div class="assert fail">layout assertions: FAILED — ${assertionSummary.detail}</div>`;
  })();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PiDeck UI gallery</title>
<style>
  body { background: #0c0d10; color: #f4f5f7; font: 14px/1.4 system-ui, sans-serif; margin: 24px; }
  h1 { font-size: 18px; }
  p { color: #8b93a0; }
  code { color: #8b93a0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 20px; }
  figure { margin: 0; border: 1px solid #262a33; border-radius: 10px; overflow: hidden; }
  img { display: block; width: 100%; height: auto; background: #0c0d10; }
  figcaption { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; font-size: 12px; }
  .name { color: #5b9cff; font-family: ui-monospace, Menlo, monospace; }
  .meta { color: #f4f5f7; }
  .design { color: #8b93a0; }
  .assert { margin: 12px 0 24px; padding: 10px 14px; border: 1px solid #262a33; border-radius: 6px; }
  .pass { color: #44c97a; }
  .fail { color: #f05d5e; }
</style>
</head>
<body>
<h1>PiDeck UI gallery</h1>
<p>Every route and state at 1280×800 and 390×844. Read each shot against <code>docs/DESIGN.md</code> — the rubric section sits under every image. Generated ${manifest.generatedAt} in ${(manifest.durationMs / 1000).toFixed(0)}s.</p>
${assertion}
<div class="grid">
${cards}
</div>
</body>
</html>`;
  writeFileSync(join(outDir, "index.html"), html);
}

// ---------------------------------------------------------------------------

async function main() {
  for (const file of [DAEMON_ENTRY, join(WEB_DIST, "index.html")]) {
    if (!existsSync(file)) {
      console.error(`Missing ${file} — run \`pnpm build\` first.`);
      process.exit(1);
    }
  }

  const temp = mkdtempSync(join(tmpdir(), "pideck-gallery-"));
  const stateDir = join(temp, "state");
  const stateEmptyDir = join(temp, "state-empty");
  const tmuxStateDir = join(temp, "tmux");
  const homeDir = join(temp, "home");
  mkdirSync(stateEmptyDir, { recursive: true });
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(join(homeDir, ".pi", "agent", "settings.json"), JSON.stringify({ defaultModel: "acme/large" }));
  writeFileSync(
    join(homeDir, ".pi", "agent", "models-store.json"),
    JSON.stringify({
      acme: { models: [{ id: "acme/large" }, { id: "acme/small" }] },
      other: { models: [{ id: "other/medium" }] },
    }),
  );

  const ghStatePath = join(temp, "fake-gh-state.json");
  writeFileSync(ghStatePath, JSON.stringify(fakeGhState(), null, 2));
  installFakeBins(temp);

  const daemonEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${join(temp, "bin")}:${process.env.PATH ?? ""}`,
    PD_HOME: stateEmptyDir,
    PD_WEB_HOST: "127.0.0.1",
    PD_POLL_INTERVAL_SECONDS: "3600",
    PD_SRC: ROOT,
    FAKE_GH_STATE: ghStatePath,
    TMUX_FAKE_STATE: tmuxStateDir,
  };
  delete daemonEnv.NODE_OPTIONS;

  let daemon = null;
  let port = 0;
  const browser = await chromium.launch();
  let desktopContext = null;
  let mobileContext = null;
  const pages = { desktop: null, mobile: null };

  const allShots = [];
  let assertionSummary = null;

  try {
    console.log("ui-gallery: booting the daemon (empty state)…");
    daemon = startDaemon(daemonEnv);
    port = await daemonPort(daemon);
    await waitForDaemon(port);

    desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      baseURL: `http://127.0.0.1:${port}`,
    });
    mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      baseURL: `http://127.0.0.1:${port}`,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    pages.desktop = await desktopContext.newPage();
    pages.mobile = await mobileContext.newPage();
    for (const page of Object.values(pages)) {
      page.on("pageerror", (err) => console.error(`[pageerror] ${err.message}`));
    }

    for (const name of ["home-empty", "home-empty-mobile"]) {
      const shot = buildShots({}).find((candidate) => candidate.name === name);
      await shot.run(pages[shot.viewport]);
      await pages[shot.viewport].screenshot({ path: join(outDir, `${name}.png`) });
      allShots.push(shot);
      console.log(`ui-gallery: captured ${name}`);
    }
    await stopDaemon(daemon);

    seedState(stateDir, tmuxStateDir);
    console.log("ui-gallery: booting the daemon (seeded state)…");
    daemon = startDaemon({ ...daemonEnv, PD_HOME: stateDir });
    port = await daemonPort(daemon);
    await waitForDaemon(port);

    // The first reconciliation derives titles and states from GitHub.
    const wanted = {
      "w-working": "working",
      "w-ci": "ci",
      "w-fixing": "fixing",
      "w-in-review": "in_review",
      "w-addressing": "addressing",
      "w-ready": "ready",
      "w-blocked": "blocked",
    };
    await waitUntil(async () => {
      const views = await api(port, "/api/sessions");
      for (const [id, state] of Object.entries(wanted)) {
        const view = views.find((candidate) => candidate.session.id === id);
        if (view === undefined || view.state !== state || view.title === null) {
          throw new Error(`waiting for ${id}`);
        }
      }
      return true;
    }, { label: "the seeded states to derive", timeoutMs: 60_000 });

    // The onboarding step shots need the review account temporarily unset so
    // the wizard starts at step 1; the review step saves it again.
    await api(port, "/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewAccount: null }),
    });

    const shots = buildShots({
      working: "w-working",
      ci: "w-ci",
      fixing: "w-fixing",
      in_review: "w-in-review",
      addressing: "w-addressing",
      ready: "w-ready",
      blocked: "w-blocked",
      archived: "w-archived",
      reviewer: "rev-171",
      global: "global",
    });
    for (const name of DESKTOP_ORDER) {
      const shot = shots.find((candidate) => candidate.name === name);
      if (shot === undefined) throw new Error(`no shot named ${name}`);
      const page = pages[shot.viewport];
      await shot.run(page);
      await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: false });
      allShots.push(shot);
      console.log(`ui-gallery: captured ${name}`);
    }

    if (assertMode) {
      console.log("ui-gallery: running layout assertions…");
      const routesFile = join(outDir, "assert-routes.json");
      writeFileSync(routesFile, JSON.stringify(routesForAssertions(), null, 2));
      const result = spawnSync("npx", ["playwright", "test", "-c", join(TOOL_DIR, "playwright.config.mjs")], {
        stdio: "inherit",
        env: { ...process.env, GALLERY_BASE_URL: `http://127.0.0.1:${port}`, GALLERY_ROUTES: routesFile },
        cwd: ROOT,
      });
      const ok = result.status === 0;
      assertionSummary = ok
        ? { ok: true, detail: "all layout assertions passed" }
        : { ok: false, detail: "see the playwright output above" };
    }

    // Archive the live workers and the reviewer so the pill shows its plain
    // available state, then click it to capture the applying state.
    const views = await api(port, "/api/sessions");
    for (const view of views) {
      const live = view.session.archivedAt === undefined;
      const agent = view.session.persona === "worker" || view.session.persona === "reviewer";
      if (live && agent) {
        await api(port, `/api/sessions/${view.session.id}/terminate`, { method: "POST" });
      }
    }
    for (const name of ["update-pill-available", "update-pill-updating"]) {
      const shot = shots.find((candidate) => candidate.name === name);
      await shot.run(pages.desktop);
      await pages.desktop.screenshot({ path: join(outDir, `${name}.png`), fullPage: false });
      allShots.push(shot);
      console.log(`ui-gallery: captured ${name}`);
    }
  } finally {
    await browser.close().catch(() => {});
    if (daemon !== null) await stopDaemon(daemon).catch(() => {});
    if (!keepTemp) rmSync(temp, { recursive: true, force: true });
  }

  writeGallery(allShots, assertionSummary);
  console.log(
    `ui-gallery: wrote ${join(outDir, "index.html")} (${allShots.length} shots) in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
  );
  if (assertionSummary !== null && !assertionSummary.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
