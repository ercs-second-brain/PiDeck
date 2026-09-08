/**
 * @pideck/github — GitHub integration layer for the PiDeck daemon.
 *
 * A library (no pipeline wiring): gh CLI wrapper with auth/permission
 * detection, repo clone/create, issue & PR list/mapping onto the shared
 * contracts, native blocked-by resolution, and poll-based issue/PR watchers.
 * Consumed by later pipeline issues (#10/#11).
 */

export * from "./gh.js";
export * from "./auth.js";
export * from "./repos.js";
export * from "./issues.js";
export * from "./pulls.js";
export * from "./watch.js";
