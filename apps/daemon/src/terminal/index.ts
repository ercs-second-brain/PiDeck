/**
 * Terminal bridge (issue #7): WebSocket ⇄ tmux streaming for browser
 * terminals. Public surface:
 * - {@link TerminalBridge} — transport-agnostic protocol logic.
 * - {@link attachTerminalWebSocket} — `ws` adapter for an http.Server.
 * - {@link FakeTmuxRunner} — fake tmux for tests.
 *
 * `standalone.ts` provides a runnable dev harness for the bridge without
 * the daemon (the full daemon HTTP server landed in issue #13).
 */

export * from "./bridge.js";
export * from "./screen.js";
export * from "./ws-server.js";
export * from "./testing/fake-tmux.js";
