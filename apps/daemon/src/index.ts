/**
 * @agentskiss/daemon — entry point.
 *
 * The full daemon wiring (project management, issue/PR watchers, kanban
 * updates) is implemented in later issues; session/worker supervision lives
 * in `src/sessions/`.
 */

export function main(): void {
  console.log("agentskiss daemon");
}

// Allow `node dist/index.js` to run as a smoke check without blocking build/test.
if (process.env["AGENTSKESS_DAEMON_RUN"] === "1") {
  main();
}
