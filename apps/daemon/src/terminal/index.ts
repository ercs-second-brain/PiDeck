/**
 * Terminal bridge (issues #7 and #67): WebSocket ⇄ tmux streaming for
 * browser terminals. Public surface:
 * - {@link TerminalBridge} — transport-agnostic protocol logic.
 * - {@link PaneEventSource} — event-driven pane output source.
 * - {@link attachTerminalWebSocket} — `ws` adapter for an http.Server.
 *
 * `standalone.ts` provides a runnable dev harness for the bridge without
 * the daemon (the full daemon HTTP server landed in issue #13); `bench.ts`
 * is a micro-benchmark for the input/output paths. The shared fake tmux
 * runner for tests lives in `sessions/testing/fake-tmux.ts`.
 */

export * from "./bridge.js";
export * from "./screen.js";
export * from "./event-source.js";
export * from "./ws-server.js";
