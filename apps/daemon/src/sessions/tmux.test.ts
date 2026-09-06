import { describe, expect, it } from "vitest";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux, TmuxError, defaultTmuxRunner } from "./tmux.js";

function makeTmux(options?: { initialPaneLines?: string[] }): {
  tmux: Tmux;
  fake: FakeTmuxRunner;
} {
  const fake = new FakeTmuxRunner({ initialPaneLines: options?.initialPaneLines });
  return { tmux: new Tmux({ runner: (args) => fake.run(args) }), fake };
}

describe("Tmux.isAvailable", () => {
  it("returns true when the tmux binary responds", async () => {
    const fake = new FakeTmuxRunner();
    expect(await Tmux.isAvailable((args) => fake.run(args))).toBe(true);
  });

  it("returns false when tmux is unavailable", async () => {
    expect(
      await Tmux.isAvailable(() => Promise.reject(new TmuxError("not found", { args: [] }))),
    ).toBe(false);
  });
});

describe("Tmux against a fake server", () => {
  it("creates, lists, and kills sessions", async () => {
    const { tmux, fake } = makeTmux();
    expect(await tmux.listSessions()).toEqual([]);

    await tmux.newSession("agentskiss-proj-orchestrator-1");
    await tmux.newSession("agentskiss-proj-worker-1", {
      cwd: "/tmp/ws",
      command: ["pi"],
    });

    expect(await tmux.hasSession("agentskiss-proj-orchestrator-1")).toBe(true);
    expect(await tmux.listSessions()).toEqual([
      "agentskiss-proj-orchestrator-1",
      "agentskiss-proj-worker-1",
    ]);
    expect(fake.sessions.get("agentskiss-proj-worker-1")?.cwd).toBe("/tmp/ws");
    expect(fake.sessions.get("agentskiss-proj-worker-1")?.command).toEqual(["pi"]);

    await tmux.killSession("agentskiss-proj-worker-1");
    expect(await tmux.hasSession("agentskiss-proj-worker-1")).toBe(false);
    expect(await tmux.listSessions()).toEqual(["agentskiss-proj-orchestrator-1"]);
  });

  it("rejects duplicate session names", async () => {
    const { tmux } = makeTmux();
    await tmux.newSession("dup");
    await expect(tmux.newSession("dup")).rejects.toBeInstanceOf(TmuxError);
  });

  it("hasSession returns false for unknown sessions without throwing", async () => {
    const { tmux } = makeTmux();
    expect(await tmux.hasSession("nope")).toBe(false);
  });

  it("captures pane contents", async () => {
    const { tmux } = makeTmux({ initialPaneLines: ["hello", "from", "pane"] });
    await tmux.newSession("sess");
    expect(await tmux.capturePane("sess")).toBe("hello\nfrom\npane");
    await expect(tmux.capturePane("missing")).rejects.toBeInstanceOf(TmuxError);
  });

  it("resizes the session window", async () => {
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    await tmux.resize("sess", 132, 43);
    expect(fake.sessions.get("sess")?.cols).toBe(132);
    expect(fake.sessions.get("sess")?.rows).toBe(43);
  });

  it("sends keys to the pane", async () => {
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    await tmux.sendKeys("sess", "go", { enter: true });
    expect(fake.sessions.get("sess")?.paneLines).toEqual(["go"]);
  });

  it("returns an empty list when no server is running", async () => {
    const fake = new FakeTmuxRunner();
    const tmux = new Tmux({
      runner: (args) => {
        const cmd = args[0];
        if (cmd === "-V") return fake.run(args);
        return Promise.reject(
          new TmuxError("error connecting to socket: No such file or directory", {
            args,
            exitCode: 1,
            stderr: "error connecting to /tmp/agentskiss-test: No such file or directory",
          }),
        );
      },
    });
    expect(await tmux.listSessions()).toEqual([]);
  });

  it("targets session:window syntax when resizing", async () => {
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    // The wrapper uses `<name>:` as the resize target; the fake must resolve it.
    await tmux.resize("sess", 100, 30);
    expect(fake.sessions.get("sess")?.cols).toBe(100);
  });
});

describe("defaultTmuxRunner", () => {
  it("wraps non-zero exits in TmuxError with stderr", async () => {
    const runner = defaultTmuxRunner("sh");
    await expect(runner(["-c", "echo boom >&2; exit 3"])).rejects.toMatchObject({
      name: "TmuxError",
      exitCode: 3,
      stderr: "boom\n",
    });
  });
});
