import { describe, expect, it } from "vitest";
import { FakeTmuxRunner } from "./testing/fake-tmux.js";
import { Tmux, TmuxError, defaultTmuxRunner } from "./tmux.js";

function makeTmux(
  options?: {
    initialPaneLines?: string[];
    /** Tmux constructor overrides (e.g. `sendEnterDelayMs: 0` for timing-free tests). */
    tmux?: ConstructorParameters<typeof Tmux>[0];
  },
): {
  tmux: Tmux;
  fake: FakeTmuxRunner;
} {
  const fake = new FakeTmuxRunner({ initialPaneLines: options?.initialPaneLines });
  return {
    tmux: new Tmux({ sendEnterDelayMs: 0, ...options?.tmux, runner: (args) => fake.run(args) }),
    fake,
  };
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

describe("Tmux.sendKeys (issue #115)", () => {
  it("sends every byte of a dash-prefixed message (issue #115)", async () => {
    // tmux parses a raw `-l <text>` argument starting with `-` as flags and
    // fails with `invalid flag` — the pre-#115 behavior that silently ate
    // orchestrator messages. Hex send-keys must be immune.
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    const message = "- fix the login bug";
    await tmux.sendKeys("sess", message, { enter: true });
    expect(fake.sentBytes("sess").toString("utf8")).toBe(message);
  });

  it("delivers payloads larger than one chunk in order (issue #115)", async () => {
    // tmux's command buffer rejects a >16KB `send-keys -l` argument with
    // `command too long` — chunked hex send-keys must reassemble exactly.
    const { tmux, fake } = makeTmux({ tmux: { sendChunkBytes: 1024 } });
    await tmux.newSession("sess");
    const message = "point 12345: the quick brown fox\n".repeat(200); // ~5.4KB ASCII
    await tmux.sendKeys("sess", message, { enter: true });
    // Multi-line payloads travel inside bracketed-paste markers (issue #115);
    // the trailing submit newline is stripped (issue #123).
    const body = message.replace(/\n$/, "");
    expect(fake.sentBytes("sess").toString("utf8")).toBe(`\x1b[200~${body}\x1b[201~`);
  });

  it("wraps multi-line payloads in bracketed paste and sends Enter separately (issue #115)", async () => {
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    const message = "line one\nline two\n- line three";
    await tmux.sendKeys("sess", message, { enter: true });
    const delivered = fake.sentBytes("sess").toString("utf8");
    expect(delivered).toBe(`\x1b[200~${message}\x1b[201~`);
    // Enter is its own invocation, after the payload flush.
    const enters = fake.invocations.filter(
      (inv) => inv.args[0] === "send-keys" && !inv.args.includes("-H") && !inv.args.includes("-l"),
    );
    expect(enters).toHaveLength(1);
    expect(enters[0]?.args).toEqual(["send-keys", "-t", "sess", "Enter"]);
  });

  it("strips the trailing newline from a paste-wrapped payload (issue #123)", async () => {
    // The orchestrator's messages end with a trailing \n; inside the paste
    // that newline is inserted by pi as literal text (a stray empty line in
    // the editor) while submission must come from the explicit Enter.
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    await tmux.sendKeys("sess", "line one\nline two\n", { enter: true });
    expect(fake.sentBytes("sess").toString("utf8")).toBe(
      "\x1b[200~line one\nline two\x1b[201~",
    );
    const enters = fake.invocations.filter((inv) => inv.args.at(-1) === "Enter");
    expect(enters).toHaveLength(1);
  });

  it("collapses an all-newlines payload to the empty nudge (issue #123)", async () => {
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    await tmux.sendKeys("sess", "\n\n", { enter: true });
    expect(fake.sentBytes("sess")).toHaveLength(0);
    const enters = fake.invocations.filter((inv) => inv.args.at(-1) === "Enter");
    expect(enters).toHaveLength(1);
  });

  it("sends plain single-line payloads without paste markers (issue #115)", async () => {
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    await tmux.sendKeys("sess", "npm test", { enter: true });
    expect(fake.sentBytes("sess").toString("utf8")).toBe("npm test");
  });

  it("presses Enter alone when the payload is empty (issue #115 nudge)", async () => {
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    await tmux.sendKeys("sess", "", { enter: true });
    expect(fake.sentBytes("sess")).toHaveLength(0);
    const enters = fake.invocations.filter((inv) => inv.args.at(-1) === "Enter");
    expect(enters).toHaveLength(1);
  });

  it("waits the settle delay before Enter when configured (issue #115)", async () => {
    const { tmux, fake } = makeTmux({ tmux: { sendEnterDelayMs: 60 } });
    await tmux.newSession("sess");
    const start = Date.now();
    await tmux.sendKeys("sess", "hello", { enter: true });
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
    expect(fake.sessions.get("sess")?.paneLines).toEqual(["hello"]);
  });

  it("delivers multi-byte UTF-8 intact (issue #115)", async () => {
    const { tmux, fake } = makeTmux();
    await tmux.newSession("sess");
    const message = "ok\u00e9\u2014 \ud83d\ude00 status";
    await tmux.sendKeys("sess", message, { enter: true });
    expect(fake.sentBytes("sess").toString("utf8")).toBe(message);
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
