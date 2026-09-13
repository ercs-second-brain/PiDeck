#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Api } from "./lib/api.mjs";
import { logLine, start, waitReady } from "./lib/daemon.mjs";
import { createRepo, deleteRepo, makeWorkspace } from "./lib/repo.mjs";
import { gh, loginForToken, primaryLogin } from "./lib/gh.mjs";
import { lines } from "./lib/views.mjs";

/**
 * `pnpm e2e` — the live SPEC §2 loop as a command. Builds the workspace,
 * creates a private throwaway repo `<owner>/pideck-e2e-<ts>` from the
 * fixture, registers it in a daemon started with PD_HOME in a throwaway dir
 * on a free loopback port, configures the review account (its PAT comes
 * from PD_E2E_REVIEW_TOKEN and is never printed), then runs the scenario:
 * a sequence of `until(gitHubFact)` assertions against GitHub and the
 * daemon's /api/sessions, bounded by --timeout. A run folder `runs/<ts>/`
 * is collected on pass or fail: result.json, the daemon log, one sessions
 * snapshot per step, and every pi transcript from the state dir's
 * pi-sessions (captured per step — archiving a session removes its
 * transcript). On pass the throwaway repo is deleted unless --keep.
 */

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const SCENARIO_MODULES = {
  "happy-path": "./scenarios/happy-path.mjs",
  blocked: "./scenarios/blocked.mjs",
  restart: "./scenarios/restart.mjs",
};

const POLL_MS = 5_000;

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
});

main()
  .catch((err) => {
    console.error(`[e2e] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (interrupted) process.exitCode = 130;
  });

async function main() {
  const { values } = parseArgs({
    options: {
      keep: { type: "boolean", default: false },
      scenario: { type: "string", default: "happy-path" },
      timeout: { type: "string", default: "20" },
    },
  });
  const scenarioName = values.scenario;
  if (SCENARIO_MODULES[scenarioName] === undefined) {
    throw new Error(`unknown scenario ${scenarioName} — known: ${Object.keys(SCENARIO_MODULES).join(", ")}`);
  }
  const timeoutMin = Number(values.timeout);
  if (!Number.isInteger(timeoutMin) || timeoutMin < 1) {
    throw new Error(`--timeout needs a whole number of minutes, got ${values.timeout}`);
  }

  // Preflight: both identities. The review token is read from the env and
  // handed only to the daemon over loopback and to `gh` via GH_TOKEN.
  const reviewToken = process.env.PD_E2E_REVIEW_TOKEN;
  if (reviewToken === undefined || reviewToken.trim() === "") {
    throw new Error(
      "PD_E2E_REVIEW_TOKEN is not set — the review account's PAT is required (see AGENTS.md)",
    );
  }
  const reviewLogin = await loginForToken(reviewToken);
  const primary = await primaryLogin();
  console.log(`[e2e] primary ${primary}, review account ${reviewLogin}`);

  const startedAt = new Date().toISOString();
  const ts = timestamp();
  const repoFull = `${primary}/pideck-e2e-${ts}`;
  const runDir = uniqueRunDir(join(ROOT, "runs", ts));
  console.log(`[e2e] scenario ${scenarioName}, timeout ${timeoutMin}m`);
  console.log("[e2e] building the workspace…");
  await build();

  const scenario = await import(SCENARIO_MODULES[scenarioName]);
  const ws = await makeWorkspace();
  mkdirSync(runDir, { recursive: true });
  console.log(`[e2e] run dir ${runDir}`);
  console.log(`[e2e] workspace ${ws.root}`);
  const steps = [];
  const result = {
    scenario: scenarioName,
    repo: repoFull,
    primary,
    reviewLogin,
    startedAt,
    finishedAt: null,
    ok: false,
    steps,
    error: null,
    repoDeleted: false,
    repoKept: values.keep,
    workspace: null,
  };
  let daemon = null;
  let api = null;
  const deadline = Date.now() + timeoutMin * 60_000;

  try {
    await createRepo(join(ROOT, "tools/e2e/fixture"), repoFull, `PiDeck e2e fixture (${scenarioName})`);

    const port = await freePort();
    daemon = start(ROOT, ws, port, ws.daemonLog, 10, ts);
    api = new Api(`http://127.0.0.1:${port}`);
    const status = await waitReady(api);
    if (status.stateDir !== ws.state) throw new Error(`daemon runs in ${status.stateDir}, expected ${ws.state}`);
    logLine(ws.daemonLog, `[e2e] daemon ready: poll ${status.pollIntervalSeconds}s, version ${status.version}`);

    await api.putReviewAccount(reviewLogin, reviewToken);
    const project = await api.createProject({ mode: "clone", repoUrl: `https://github.com/${repoFull}.git` });
    await api.putProjectSettings(project.id, { autoMerge: true });
    console.log(`[e2e] project ${project.id} registered; asserting review access…`);
    await until(runDir, api, ws, deadline, steps, "review account read access", () =>
      gh(["api", `repos/${repoFull}`], { GH_TOKEN: reviewToken }).then(() => true));

    await scenario.run({
      scenarioName,
      repoFull,
      primary,
      projectId: project.id,
      sessions: () =>
        api.sessions().then((all) =>
          all.filter((v) => v.session.archivedAt === undefined && v.session.projectId === project.id)),
      allSessions: () =>
        api.sessions().then((all) => all.filter((v) => v.session.projectId === project.id)),
      until: (label, fact) => until(runDir, api, ws, deadline, steps, label, fact),
      restart: async () => {
        console.log("[e2e] killing the daemon mid-loop…");
        await daemon.kill("SIGTERM");
        logLine(ws.daemonLog, "[e2e] daemon killed mid-loop; restarting on the same state dir");
        daemon = start(ROOT, ws, port, ws.daemonLog, 10, ts);
        await waitReady(api);
        logLine(ws.daemonLog, "[e2e] daemon restarted");
      },
    });
    result.ok = true;
    console.log(`[e2e] scenario ${scenarioName} passed`);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`[e2e] scenario ${scenarioName} failed:`, err instanceof Error ? err.stack : err);
  } finally {
    // Let in-flight API calls settle before the daemon goes down, so a
    // failed call cannot escalate into an unhandled rejection that kills
    // the process before result.json and cleanup run.
    if (api !== null) await api.quiesce();
    if (daemon !== null) await daemon.kill().catch(() => {});
    result.finishedAt = new Date().toISOString();
    if (interrupted) {
      result.ok = false;
      result.error ??= "interrupted";
    }
    collect(runDir, ws, api);
    // Never leave a repo behind unless --keep was asked for explicitly —
    // pass or fail. A missing delete_repo scope is reported with a hint,
    // not a crash.
    if (!values.keep) {
      try {
        await deleteRepo(repoFull);
        result.repoDeleted = true;
        console.log(`[e2e] deleted ${repoFull}`);
      } catch {
        console.warn(
          `[e2e] could not delete ${repoFull} — grant the primary gh token the ` +
          `delete_repo scope (\`gh auth refresh -h github.com -s delete_repo\`) and remove it by hand`,
        );
        result.workspace = ws.root;
      }
    } else {
      result.workspace = ws.root;
    }
    writeFileSync(join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (result.ok) {
      ws.dispose();
      console.log(`[e2e] passed — artifacts in ${runDir}`);
    } else {
      process.exitCode = 1;
      console.error(`[e2e] FAILED — run in ${runDir}, workspace in ${ws.root}`);
    }
  }
}

/** Builds every workspace package so the daemon under test is current code. */
function build() {
  return new Promise((res, rej) => {
    const child = spawn("pnpm", ["-r", "build"], { cwd: ROOT, stdio: "inherit" });
    child.on("error", rej);
    child.on("close", (code) => {
      if (code === 0 && existsSync(join(ROOT, "apps/daemon/dist/index.js"))) res();
      else rej(new Error("pnpm -r build failed — the e2e run needs current build output"));
    });
  });
}

/** One `until` assertion: poll a fact until truthy or the run deadline passes. */
async function until(runDir, api, ws, deadline, steps, label, fact) {
  const startedAt = Date.now();
  for (;;) {
    let value = false;
    try {
      value = await fact();
    } catch {
      value = false;
    }
    if (value) {
      steps.push({ label, at: new Date().toISOString(), ms: Date.now() - startedAt });
      console.log(`[e2e] ${String(steps.length).padStart(2, "0")}. ${label} (${fmtMs(steps[steps.length - 1].ms)})`);
      await snapshot(runDir, api, ws, `${String(steps.length).padStart(2, "0")}-${slug(label)}`);
      return value;
    }
    if (Date.now() >= deadline) {
      const inventory = lines(await api.sessions()).join("\n") || "(no live sessions)";
      throw new Error(
        `timed out after ${fmtMs(Date.now() - startedAt)} waiting for: ${label}\n${inventory}`,
      );
    }
    await sleep(POLL_MS);
  }
}

/** One sessions snapshot per step; transcripts captured alongside it. */
async function snapshot(runDir, api, ws, name) {
  const views = await api.sessions();
  mkdirSync(join(runDir, "sessions"), { recursive: true });
  writeFileSync(join(runDir, "sessions", `${name}.json`), `${JSON.stringify(views, null, 2)}\n`);
  captureTranscripts(runDir, ws.state);
}

function captureTranscripts(runDir, stateDir) {
  // pi-sessions is pi's per-session transcript storage; archiving a session
  // removes its directory, so every capture keeps the newest copy of each
  // transcript seen so far in the run folder.
  let entries;
  try {
    entries = readdirSync(join(stateDir, "pi-sessions"), { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.length === 0) return;
  mkdirSync(join(runDir, "transcripts"), { recursive: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    cpSync(
      join(stateDir, "pi-sessions", entry.name),
      join(runDir, "transcripts", entry.name),
      { recursive: true, force: true },
    );
  }
}

/** Final run-folder pass: daemon log, last snapshot, newest transcripts. */
function collect(runDir, ws, api) {
  try {
    cpSync(ws.daemonLog, join(runDir, "daemon.log"));
  } catch {
    // the daemon never wrote — the startup failure is in the output above
  }
  if (api !== null) {
    snapshot(runDir, api, ws, "99-final").catch(() => {});
  } else {
    captureTranscripts(runDir, ws.state);
  }
}

function freePort() {
  return new Promise((res, rej) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => res(port));
    });
  });
}

function fmtMs(ms) {
  return ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function uniqueRunDir(path) {
  if (!existsSync(path)) return path;
  for (let n = 2; ; n++) {
    const candidate = `${path}-${n}`;
    if (!existsSync(candidate)) return candidate;
  }
}
