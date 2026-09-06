/**
 * @agentskiss/daemon — placeholder entry point.
 *
 * The real daemon (project management, issue/PR watchers, tmux session
 * supervision) is implemented in a later issue. This entry point only proves
 * the workspace builds and links against @agentskiss/shared.
 */

import { placeholder } from "@agentskiss/shared";

export function main(): void {
  console.log(`agentskiss daemon placeholder (${placeholder()})`);
}

// Allow `node dist/index.js` to run as a smoke check without blocking build/test.
if (process.env["AGENTSKESS_DAEMON_RUN"] === "1") {
  main();
}
