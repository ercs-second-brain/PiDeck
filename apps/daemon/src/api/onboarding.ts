import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { errorMessage, type ReviewLoginStart, type ReviewLoginStatus } from "@pideck/shared";
import type { GlobalSettingsStore } from "../store/globalSettingsStore.js";

export type GhProcessSpawner = (args: string[], env: NodeJS.ProcessEnv) => ChildProcess;

function defaultSpawner(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn("gh", args, { env, stdio: ["ignore", "pipe", "pipe"] });
}

/** gh prints the one-time code and the device URL on stderr, then blocks. */
export function parseDeviceOutput(stderr: string): ReviewLoginStart | null {
  const code = stderr.match(/one-time code:\s*(\S+)/i)?.[1];
  const url = stderr.match(/Open this URL to continue in your web browser:\s*(\S+)/i)?.[1];
  return code !== undefined && url !== undefined ? { code, url } : null;
}

/**
 * The review account's device-code login: `gh auth login --web` runs under a
 * dedicated gh config dir (`<stateDir>/gh-review`, so the primary account's
 * auth is untouched) and shows a one-time code + URL; once the user finishes
 * in the browser the token is read with `gh auth token`, the username with
 * `gh api user`, and both are stored as the review account. One flow at a
 * time; a flow times out after 15 minutes.
 */
export class ReviewLoginFlow {
  private timer: NodeJS.Timeout | null = null;
  private state: ReviewLoginStatus = { status: "pending", detail: null };
  private code: ReviewLoginStart | null = null;
  private launching: Promise<ReviewLoginStart> | null = null;

  constructor(
    private readonly stateDir: string,
    private readonly settings: GlobalSettingsStore,
    private readonly spawnGh: GhProcessSpawner = defaultSpawner,
    private readonly timeoutMs = 15 * 60 * 1000,
  ) {}

  status(): ReviewLoginStatus {
    return { ...this.state };
  }

  /** Idempotent while a flow is running: a second start returns its code. */
  start(): Promise<ReviewLoginStart> {
    if (this.state.status === "pending") {
      if (this.code !== null) return Promise.resolve(this.code);
      if (this.launching !== null) return this.launching;
    }
    this.state = { status: "pending", detail: null };
    this.code = null;
    let resolveStart: (start: ReviewLoginStart) => void;
    let rejectStart: (err: Error) => void;
    this.launching = new Promise<ReviewLoginStart>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    this.spawnLogin(resolveStart!, rejectStart!);
    return this.launching;
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: join(this.stateDir, "gh-review") };
    // The flow must authenticate as itself; a token in the daemon's
    // environment is the primary account's and would override the config dir.
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    return env;
  }

  private spawnLogin(resolveStart: (start: ReviewLoginStart) => void, rejectStart: (err: Error) => void): void {
    let stderr = "";
    let parsed = false;
    const child = this.spawnGh(["auth", "login", "--web", "--git-protocol", "https"], this.env());
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (!parsed) {
        const start = parseDeviceOutput(stderr);
        if (start !== null) {
          parsed = true;
          this.code = start;
          resolveStart(start);
        }
      }
    });
    child.on("error", (err) => {
      if (this.state.status === "pending" && !parsed) rejectStart(new Error(errorMessage(err)));
      this.finish({ status: "failed", detail: errorMessage(err) });
    });
    child.on("close", (exitCode) => {
      if (this.state.status !== "pending") return;
      if (exitCode === 0) void this.complete();
      else {
        this.finish({
          status: "failed",
          detail: stderr.trim() || `gh auth login exited with code ${exitCode}`,
        });
      }
    });
    this.timer = setTimeout(() => {
      this.finish({ status: "failed", detail: "device sign-in timed out after 15 minutes" });
      child.kill();
    }, this.timeoutMs);
  }

  /** gh exited cleanly: read the credentials back and store them. */
  private async complete(): Promise<void> {
    try {
      const env = this.env();
      const token = (await this.run(["auth", "token"], env)).stdout.trim();
      if (token === "") throw new Error("gh auth token returned no token");
      const username = (
        await this.run(["api", "user", "--jq", ".login"], { ...env, GH_TOKEN: token })
      ).stdout.trim();
      if (username === "") throw new Error("could not resolve the review account's username");
      this.settings.put({ reviewAccount: { username, token } });
      this.finish({ status: "done", detail: null });
    } catch (err) {
      this.finish({ status: "failed", detail: errorMessage(err) });
    }
  }

  private run(
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnGh(args, env);
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        if (exitCode === 0) resolve({ stdout, stderr, exitCode });
        else {
          reject(
            new Error(stderr.trim() || stdout.trim() || `gh ${args.join(" ")} failed`),
          );
        }
      });
    });
  }

  private finish(state: ReviewLoginStatus): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.state = state;
    this.launching = null;
  }
}
