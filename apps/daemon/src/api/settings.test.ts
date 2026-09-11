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
      defaultWorkerConcurrency: 3,
      terminateOnMerge: true,
      autoFixCi: true,
      autoFixReviewComments: true,
      autoReview: true,
      workerReuseContextThreshold: 20,
      reviewAccountUsername: null,
      reviewAccountToken: null,
      browserMergeNotifications: false,
    });
    store.update({ defaultWorkerConcurrency: 5 });
    expect(store.get().defaultWorkerConcurrency).toBe(5);

    const reloaded = new SettingsStore(dir);
    expect(reloaded.get().defaultWorkerConcurrency).toBe(5);
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

  it("defaults the merged-PR browser notification OFF and persists the opt-in (issue #111)", () => {
    const dir = testDaemon().stateDir;
    const store = new SettingsStore(dir);
    expect(store.get().browserMergeNotifications).toBe(false);
    store.update({ browserMergeNotifications: true });
    expect(new SettingsStore(dir).get().browserMergeNotifications).toBe(true);
  });

  it("defaults the reuse context threshold to 20% and persists changes (issue #471)", () => {
    const dir = testDaemon().stateDir;
    const store = new SettingsStore(dir);
    expect(store.get().workerReuseContextThreshold).toBe(20);
    store.update({ workerReuseContextThreshold: 35 });
    expect(new SettingsStore(dir).get().workerReuseContextThreshold).toBe(35);
    // Validation: an out-of-range update throws (→ 400 via the router).
    expect(() => store.update({ workerReuseContextThreshold: 0 })).toThrow();
    expect(() => store.update({ workerReuseContextThreshold: 101 })).toThrow();
  });

  it("defaults the review account OFF (single-account mode) and persists it (issue #407)", () => {
    const dir = testDaemon().stateDir;
    const store = new SettingsStore(dir);
    expect(store.get().reviewAccountToken).toBeNull();
    expect(store.get().reviewAccountUsername).toBeNull();
    store.update({ reviewAccountToken: "ghp_review", reviewAccountUsername: "review-bot" });
    const reloaded = new SettingsStore(dir);
    expect(reloaded.get().reviewAccountToken).toBe("ghp_review");
    expect(reloaded.get().reviewAccountUsername).toBe("review-bot");
  });

  it("fills the worker-pipeline toggles into a pre-#106 settings file (upgrade path)", () => {
    const dir = testDaemon().stateDir;
    mkdirSync(dir, { recursive: true });
    // A pre-#416 file still carrying the removed autoAgentUsername field
    // upgrades on load (unknown keys are stripped).
    writeFileSync(`${dir}/settings.json`, JSON.stringify({ autoAgentUsername: "old-bot", defaultWorkerConcurrency: 2, version: 1 }));
    const store = new SettingsStore(dir);
    expect(store.get()).toEqual({
      defaultWorkerConcurrency: 2,
      terminateOnMerge: true,
      autoFixCi: true,
      autoFixReviewComments: true,
      autoReview: true,
      workerReuseContextThreshold: 20,
      reviewAccountUsername: null,
      reviewAccountToken: null,
      browserMergeNotifications: false,
    });
  });

  it("rejects out-of-contract values", () => {
    const store = new SettingsStore(testDaemon().stateDir);
    expect(() => store.update({ defaultWorkerConcurrency: 99 })).toThrow();
    expect(() => store.update({ autoFixCi: "yes" as unknown as boolean })).toThrow();
  });

  it("rejects the review-account pair set without each other (both-or-neither, issue #424)", () => {
    const dir = testDaemon().stateDir;
    const store = new SettingsStore(dir);
    expect(() => store.update({ reviewAccountToken: "ghp_review" })).toThrow(/both-or-neither|together/);
    expect(() => store.update({ reviewAccountUsername: "review-bot" })).toThrow();
    expect(store.get().reviewAccountToken).toBeNull();
    expect(store.get().reviewAccountUsername).toBeNull();

    // Setting both is fine, and so is clearing both.
    store.update({ reviewAccountToken: "ghp_review", reviewAccountUsername: "review-bot" });
    expect(store.get().reviewAccountUsername).toBe("review-bot");
    store.update({ reviewAccountToken: null, reviewAccountUsername: null });
    expect(store.get().reviewAccountToken).toBeNull();
  });
});
