import { describe, expect, it } from "vitest";
import {
  Tmux,
  TmuxError,
  defaultTmuxRunner,
  type CommandResult,
  type TmuxRunner,
} from "./tmux.js";

function fakeRunner(handler?: (args: string[]) => CommandResult): {
  tmux: Tmux;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: TmuxRunner = async (args) => {
    calls.push(args);
    if (handler) return handler(args);
    return { stdout: "", stderr: "" };
  };
  return {
    tmux: new Tmux({ runner, enterDelayMs: 0, verifyDelayMs: 0 }),
    calls,
  };
}

const err = (exitCode: number, stderr = ""): CommandResult & { failed: true } => {
  throw new TmuxError("failed", { args: [], exitCode, stderr });
};

describe("Tmux", () => {
  it("creates a detached session with a named window running a command in a cwd", async () => {
    const { tmux, calls } = fakeRunner();
    await tmux.create("s1", {
      cwd: "/repo",
      windowName: "worker",
      command: ["pi", "--model", "m"],
    });
    expect(calls[0]).toEqual([
      "new-session",
      "-d",
      "-x",
      "200",
      "-y",
      "50",
      "-s",
      "s1",
      "-n",
      "worker",
      "-c",
      "/repo",
      "pi",
      "--model",
      "m",
    ]);
    expect(calls[1]).toEqual(["set-option", "-t", "s1", "window-size", "manual"]);
  });

  it("injects env pane-side via an export wrapper", async () => {
    const { tmux, calls } = fakeRunner();
    await tmux.create("s1", {
      cwd: "/repo",
      command: ["pi"],
      env: { PD_SESSION_ID: "abc", GH_TOKEN: "it's" },
    });
    const cmd = calls[0]!;
    const script = cmd[cmd.length - 3]!;
    expect(script).toContain("PD_SESSION_ID='abc'");
    expect(script).toContain("GH_TOKEN='it'\\''s'");
    expect(cmd[cmd.length - 2]).toBe("sh");
    expect(cmd.slice(-1)).toEqual(["pi"]);
  });

  it("exports env alone as a login shell when no command is given", async () => {
    const { tmux, calls } = fakeRunner();
    await tmux.create("s1", { cwd: "/repo", env: { A: "1" } });
    const cmd = calls[0]!;
    expect(cmd.slice(-3)).toEqual(["sh", "-c", expect.stringContaining("exec")]);
  });

  it("isAlive maps exit code 1 to false and rethrows other failures", async () => {
    const { tmux, calls } = fakeRunner((args) =>
      args[0] === "has-session" ? err(1) : { stdout: "", stderr: "" },
    );
    await expect(tmux.isAlive("gone")).resolves.toBe(false);
    expect(calls[0]).toEqual(["has-session", "-t", "gone"]);
  });

  it("sendLine types the text in hex chunks, presses Enter, then verifies submission", async () => {
    const { tmux, calls } = fakeRunner();
    await tmux.sendLine("s1", "hello");
    expect(calls).toHaveLength(3);
    expect(calls[0]![0]).toBe("send-keys");
    expect(calls[0]!.slice(1, 3)).toEqual(["-t", "s1"]);
    expect(calls[1]).toEqual(["send-keys", "-t", "s1", "Enter"]);
    expect(calls[2]).toEqual(["capture-pane", "-p", "-J", "-t", "s1"]);
    const hex = calls[0]!.slice(3);
    expect(hex[0]).toBe("-H");
    const bytes = hex.slice(1).map((h) => parseInt(h, 16));
    expect(Buffer.from(bytes).toString()).toBe("hello");
  });

  it("sendLine resends Enter while the draft is still in the input area, at most three times", async () => {
    const logs: string[] = [];
    const calls: string[][] = [];
    // The draft stays on screen for the first two checks, then submits.
    let captures = 0;
    const runner: TmuxRunner = async (args) => {
      calls.push(args);
      if (args[0] === "capture-pane") {
        captures++;
        return captures <= 2
          ? { stdout: "...\nWorker session for issue #1", stderr: "" }
          : { stdout: "...\n(something else)", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const tmux = new Tmux({ runner, enterDelayMs: 0, verifyDelayMs: 0, log: (l) => logs.push(l) });
    await tmux.sendLine("s1", "Worker session for issue #1");
    const enters = calls.filter((c) => c.at(-1) === "Enter");
    expect(enters).toHaveLength(3);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("resending Enter (attempt 2 of 3)");
  });

  it("sendLine never presses Enter more than three times even if the draft never submits", async () => {
    const calls: string[][] = [];
    const runner: TmuxRunner = async (args) => {
      calls.push(args);
      if (args[0] === "capture-pane") {
        return { stdout: "Worker session for issue #1", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const tmux = new Tmux({ runner, enterDelayMs: 0, verifyDelayMs: 0 });
    await tmux.sendLine("s1", "Worker session for issue #1");
    expect(calls.filter((c) => c.at(-1) === "Enter")).toHaveLength(3);
  });

  it("sendLine strips a trailing newline and chunks long payloads", async () => {
    const { tmux, calls } = fakeRunner();
    await tmux.sendLine("s1", `${"x".repeat(9000)}\n`);
    const chunkCalls = calls.filter((c) => c[3] === "-H");
    expect(chunkCalls.length).toBeGreaterThanOrEqual(3);
    const allBytes = chunkCalls.flatMap((c) => c.slice(4).map((h) => parseInt(h, 16)));
    expect(Buffer.from(allBytes).toString()).toBe("x".repeat(9000));
    const enters = calls.filter((c) => c.at(-1) === "Enter");
    expect(enters).toHaveLength(1);
    expect(calls.indexOf(enters[0]!)).toBeGreaterThan(calls.indexOf(chunkCalls.at(-1)!));
  });

  it("sendLine serializes concurrent sends per target", async () => {
    const { tmux, calls } = fakeRunner();
    const first = tmux.sendLine("s1", "one");
    const second = tmux.sendLine("s1", "two");
    await Promise.all([first, second]);
    const enters = calls.map((c, i) => (c.at(-1) === "Enter" ? i : -1)).filter((i) => i >= 0);
    const chunksOf = (word: string) =>
      calls.filter((c) => Buffer.from(c.slice(4).map((h) => parseInt(h, 16))).toString() === word);
    const lastOne = calls.indexOf(chunksOf("one").at(-1)!);
    const lastTwo = calls.indexOf(chunksOf("two").at(-1)!);
    expect(enters[0]).toBeGreaterThan(lastOne);
    expect(enters[0]).toBeLessThan(lastTwo);
  });

  it("kill targets the session", async () => {
    const { tmux, calls } = fakeRunner();
    await tmux.kill("s1");
    expect(calls[0]).toEqual(["kill-session", "-t", "s1"]);
  });

  it("capturePane captures full scrollback with escapes and joins", async () => {
    const { tmux, calls } = fakeRunner(() => ({ stdout: "line1\nline2\n", stderr: "" }));
    await expect(tmux.capturePane("s1")).resolves.toBe("line1\nline2");
    expect(calls[0]).toEqual([
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-t",
      "s1",
      "-S",
      "-",
    ]);
  });

  it("listSessions returns names and [] when no server is running", async () => {
    const a = fakeRunner(() => ({ stdout: "s1\ns2\n", stderr: "" }));
    await expect(a.tmux.listSessions()).resolves.toEqual(["s1", "s2"]);
    const b = fakeRunner(() => err(1, "no server running on /tmp/tmux-0/default"));
    await expect(b.tmux.listSessions()).resolves.toEqual([]);
  });

  it("runs commands against a private socket when given", async () => {
    const calls: string[][] = [];
    const tmux = new Tmux({
      runner: async (args) => {
        calls.push(args);
        return { stdout: "", stderr: "" };
      },
      socketName: "pideck-test",
    });
    await tmux.isAlive("s1");
    expect(calls[0]).toEqual(["-L", "pideck-test", "has-session", "-t", "s1"]);
  });

  it("detects tmux availability", async () => {
    await expect(Tmux.isAvailable(defaultTmuxRunner())).resolves.toBe(typeof process !== "undefined");
  });
});
