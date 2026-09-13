import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restEndpoints, type ReviewLoginStart, type ReviewLoginStatus } from "@pideck/shared";
import { parseDeviceOutput, ReviewLoginFlow } from "./onboarding.js";
import { serve } from "./server.js";
import { makeDeps } from "./testing.js";
import { FakeTmux } from "../sessions/testing/fakeTmux.js";

/**
 * A fake gh that reproduces the real device flow's shape: `auth login --web`
 * prints the one-time code and URL to stderr, then blocks until the signal
 * file appears; `auth token` and `api user` answer as the signed-in account.
 */
function installFakeGh(binDir: string): void {
  const script = [
    "#!/bin/sh",
    'case "$1 $2" in',
    '  "auth login")',
    '    printf \'\\n! First copy your one-time code: %s\\n\' "${FAKE_CODE:-ABCD-1234}" >&2',
    '    printf \'Open this URL to continue in your web browser: https://github.com/login/device\\n\' >&2',
    "    i=0",
    '    while [ ! -e "${FAKE_FINISH:-/nonexistent}" ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i + 1)); done',
    '    if [ "${FAKE_LOGIN_EXIT:-0}" != "0" ]; then printf \'error: device flow failed\\n\' >&2; fi',
    '    exit "${FAKE_LOGIN_EXIT:-0}"',
    "    ;;",
    '  "auth token")',
    '    printf \'%s\\n\' "${FAKE_TOKEN:-ghp_device_token}"',
    "    ;;",
    '  "api"*)',
    '    printf \'%s\\n\' "${FAKE_LOGIN_NAME:-reviewer-bot}"',
    "    ;;",
    "  *)",
    '    printf \'fake gh: unhandled %s\\n\' "$*" >&2',
    "    exit 1",
    "esac",
  ].join("\n");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "gh");
  writeFileSync(bin, script, "utf8");
  chmodSync(bin, 0o755);
}

let dirs: string[] = [];
let previousEnv: Record<string, string | undefined>;
const ENV_NAMES = ["FAKE_CODE", "FAKE_FINISH", "FAKE_LOGIN_EXIT", "FAKE_TOKEN", "FAKE_LOGIN_NAME", "GH_TOKEN", "GITHUB_TOKEN"] as const;

beforeEach(() => {
  previousEnv = {};
  for (const name of ENV_NAMES) {
    previousEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  for (const [name, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function tempDir(): string {
  const dir = join(tmpdir(), `pideck-review-login-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  return dir;
}

function spawnGhFrom(binDir: string): ConstructorParameters<typeof ReviewLoginFlow>[2] {
  return (args, env) =>
    spawn("gh", args, { env: { ...env, PATH: `${binDir}:${env.PATH ?? ""}` }, stdio: ["ignore", "pipe", "pipe"] });
}

function waitFor<T>(probe: () => T, match: (value: T) => boolean, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const value = probe();
      if (match(value)) return resolve(value);
      if (Date.now() - started > 10_000) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("parseDeviceOutput", () => {
  it("reads the code and URL from gh's stderr shape", () => {
    const stderr = [
      "",
      "! First copy your one-time code: E0F2-CD63",
      "Open this URL to continue in your web browser: https://github.com/login/device",
      "",
    ].join("\n");
    expect(parseDeviceOutput(stderr)).toEqual({
      code: "E0F2-CD63",
      url: "https://github.com/login/device",
    });
  });

  it("returns null while the code has not appeared yet", () => {
    expect(parseDeviceOutput("gh version 2.45.0\n")).toBeNull();
  });
});

describe("ReviewLoginFlow", () => {
  it("reports the code and URL, then stores the account once gh finishes", async () => {
    const stateDir = tempDir();
    const deps = makeDeps(stateDir, new FakeTmux());
    const binDir = tempDir();
    mkdirSync(binDir, { recursive: true });
    installFakeGh(binDir);
    const finishFile = join(binDir, "finish");
    process.env.FAKE_FINISH = finishFile;
    const flow = new ReviewLoginFlow(stateDir, deps.settings, spawnGhFrom(binDir));
    deps.reviewLogin = flow;

    const start = await flow.start();
    expect(start).toEqual({ code: "ABCD-1234", url: "https://github.com/login/device" });
    expect(flow.status().status).toBe("pending");

    // A second start while pending is idempotent.
    expect(await flow.start()).toEqual(start);

    writeFileSync(finishFile, "done\n");
    const status = await waitFor(
      () => flow.status(),
      (entry) => entry.status !== "pending",
      "the flow to finish",
    );
    expect(status).toEqual({ status: "done", detail: null });
    expect(deps.settings.reviewToken()).toEqual({
      username: "reviewer-bot",
      token: "ghp_device_token",
    });
  });

  it("reports a failure with gh's detail when the login does not complete", async () => {
    const stateDir = tempDir();
    const deps = makeDeps(stateDir, new FakeTmux());
    const binDir = tempDir();
    mkdirSync(binDir, { recursive: true });
    installFakeGh(binDir);
    const finishFile = join(binDir, "finish");
    process.env.FAKE_FINISH = finishFile;
    process.env.FAKE_LOGIN_EXIT = "1";
    const flow = new ReviewLoginFlow(stateDir, deps.settings, spawnGhFrom(binDir));
    deps.reviewLogin = flow;

    const start = await flow.start();
    expect(start.code).toBe("ABCD-1234");
    writeFileSync(finishFile, "done\n");
    const status = await waitFor(
      () => flow.status(),
      (entry) => entry.status !== "pending",
      "the flow to fail",
    );
    expect(status.status).toBe("failed");
    expect(status.detail).toContain("device flow failed");
    expect(deps.settings.onboarded()).toBe(false);
  });

  it("times a running flow out", async () => {
    const stateDir = tempDir();
    const deps = makeDeps(stateDir, new FakeTmux());
    const binDir = tempDir();
    mkdirSync(binDir, { recursive: true });
    installFakeGh(binDir);
    const flow = new ReviewLoginFlow(stateDir, deps.settings, spawnGhFrom(binDir), 150);
    deps.reviewLogin = flow;

    await flow.start();
    const status = await waitFor(
      () => flow.status(),
      (entry) => entry.status !== "pending",
      "the flow to time out",
    );
    expect(status.status).toBe("failed");
    expect(status.detail).toContain("timed out");
    expect(deps.settings.onboarded()).toBe(false);
  });
});

describe("review login REST endpoints", () => {
  it("starts the flow and reports its status through the shared contract", async () => {
    const stateDir = tempDir();
    const deps = makeDeps(stateDir, new FakeTmux());
    const binDir = tempDir();
    installFakeGh(binDir);
    process.env.FAKE_FINISH = join(binDir, "finish");
    deps.reviewLogin = new ReviewLoginFlow(stateDir, deps.settings, spawnGhFrom(binDir));
    const daemon = await serve(deps, { host: "127.0.0.1", port: 0 });
    try {
      const base = `http://127.0.0.1:${daemon.port}`;
      const res = await fetch(`${base}${restEndpoints["reviewLoginStart"].path}`, { method: "POST" });
      expect(res.status).toBe(200);
      const start = (await res.json()) as ReviewLoginStart;
      expect(start).toEqual({ code: "ABCD-1234", url: "https://github.com/login/device" });

      const statusRes = await fetch(`${base}${restEndpoints["reviewLoginStatus"].path}`);
      const status = (await statusRes.json()) as ReviewLoginStatus;
      expect(status.status).toBe("pending");
      expect(status.detail).toBeNull();
    } finally {
      await daemon.close();
    }
  });
});
