/**
 * SettingsStore tests (issue #106): daemon-wide settings persistence, the
 * worker-pipeline toggle defaults, and the pre-#106 file upgrade path.
 * HTTP contract coverage for `GET/PUT /api/settings` lives in
 * `contract.test.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SettingsStore } from "./settings.js";
import { testDaemon } from "./testutil.js";

describe("SettingsStore", () => {
  it("applies partial updates and reloads from disk", () => {
    const dir = testDaemon().stateDir;
    const store = new SettingsStore(dir);
    expect(store.get()).toEqual({
      autoAgentUsername: null,
      defaultWorkerConcurrency: 1,
      terminateOnMerge: true,
      autoFixCi: true,
      autoFixReviewComments: true,
      autoReview: true,
    });
    store.update({ autoAgentUsername: "auto-agent" });
    expect(store.get()).toEqual({
      autoAgentUsername: "auto-agent",
      defaultWorkerConcurrency: 1,
      terminateOnMerge: true,
      autoFixCi: true,
      autoFixReviewComments: true,
      autoReview: true,
    });

    const reloaded = new SettingsStore(dir);
    expect(reloaded.get().autoAgentUsername).toBe("auto-agent");
  });

  it("defaults the worker-pipeline toggles ON and persists changes (issue #106)", () => {
    const dir = testDaemon().stateDir;
    const store = new SettingsStore(dir);
    store.update({ autoFixCi: false, terminateOnMerge: false });
    const reloaded = new SettingsStore(dir);
    expect(reloaded.get().autoFixCi).toBe(false);
    expect(reloaded.get().terminateOnMerge).toBe(false);
    expect(reloaded.get().autoFixReviewComments).toBe(true);
  });

  it("fills the worker-pipeline toggles into a pre-#106 settings file (upgrade path)", () => {
    const dir = testDaemon().stateDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/settings.json`, JSON.stringify({ autoAgentUsername: null, defaultWorkerConcurrency: 2, version: 1 }));
    const store = new SettingsStore(dir);
    expect(store.get()).toEqual({
      autoAgentUsername: null,
      defaultWorkerConcurrency: 2,
      terminateOnMerge: true,
      autoFixCi: true,
      autoFixReviewComments: true,
      autoReview: true,
    });
  });

  it("rejects out-of-contract values", () => {
    const store = new SettingsStore(testDaemon().stateDir);
    expect(() => store.update({ defaultWorkerConcurrency: 99 })).toThrow();
    expect(() => store.update({ autoFixCi: "yes" as unknown as boolean })).toThrow();
  });
});
