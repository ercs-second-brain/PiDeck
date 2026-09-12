import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalSettingsStore } from "./globalSettingsStore.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "pideck-settings-"));
  return dir;
}

describe("GlobalSettingsStore", () => {
  it("starts with the shared-contract defaults", () => {
    const store = new GlobalSettingsStore(tempDir());
    expect(store.read()).toEqual({
      reviewAccount: null,
      modelByPersona: { global: null, orchestrator: null, worker: null, reviewer: null },
    });
    expect(store.reviewToken()).toBeNull();
  });

  it("saves the review account and masks the token on read", () => {
    const stateDir = tempDir();
    const store = new GlobalSettingsStore(stateDir);

    store.put({ reviewAccount: { username: "review-bot", token: "ghp_secret" } });
    expect(store.read().reviewAccount).toEqual({ username: "review-bot", tokenSet: true });
    expect(store.reviewToken()).toEqual({ username: "review-bot", token: "ghp_secret" });

    const raw = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8"));
    expect(raw.reviewAccount).toEqual({ username: "review-bot", token: "ghp_secret" });
  });

  it("reuses the existing token when a username is saved without one", () => {
    const store = new GlobalSettingsStore(tempDir());
    store.put({ reviewAccount: { username: "review-bot", token: "ghp_secret" } });

    store.put({ reviewAccount: { username: "renamed-bot" } });
    expect(store.reviewToken()).toEqual({ username: "renamed-bot", token: "ghp_secret" });
  });

  it("rejects a username with no token at all", () => {
    const store = new GlobalSettingsStore(tempDir());
    expect(() => store.put({ reviewAccount: { username: "review-bot" } })).toThrow(
      /both or neither/,
    );
    expect(store.read().reviewAccount).toBeNull();
  });

  it("clears the review account entirely", () => {
    const store = new GlobalSettingsStore(tempDir());
    store.put({ reviewAccount: { username: "review-bot", token: "ghp_secret" } });

    store.put({ reviewAccount: null });
    expect(store.read().reviewAccount).toBeNull();
    expect(store.reviewToken()).toBeNull();
  });

  it("saves model per persona", () => {
    const store = new GlobalSettingsStore(tempDir());
    store.put({ modelByPersona: { global: null, orchestrator: null, worker: "m1", reviewer: null } });
    expect(store.read().modelByPersona).toEqual({
      global: null,
      orchestrator: null,
      worker: "m1",
      reviewer: null,
    });
    store.setModel("reviewer", "m2");
    expect(store.read().modelByPersona.reviewer).toBe("m2");
    expect(store.read().modelByPersona.worker).toBe("m1");
  });

  it("persists across instances", () => {
    const stateDir = tempDir();
    new GlobalSettingsStore(stateDir).put({
      reviewAccount: { username: "review-bot", token: "ghp_secret" },
    });
    const reopened = new GlobalSettingsStore(stateDir);
    expect(reopened.reviewToken()).toEqual({ username: "review-bot", token: "ghp_secret" });
  });

  it("throws a clear error on a corrupt settings file", () => {
    const stateDir = tempDir();
    writeFileSync(join(stateDir, "settings.json"), "{ not json");
    expect(() => new GlobalSettingsStore(stateDir)).toThrow(/settings\.json/);
  });

  it("throws a clear error on a schema-invalid settings file", () => {
    const stateDir = tempDir();
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({ reviewAccount: { username: "x" } }),
    );
    expect(() => new GlobalSettingsStore(stateDir)).toThrow(/settings\.json/);
  });

  it("writes atomically without leaving temp files", () => {
    const stateDir = tempDir();
    const store = new GlobalSettingsStore(stateDir);
    store.put({ reviewAccount: { username: "review-bot", token: "ghp_secret" } });
    expect(existsSync(join(stateDir, "settings.json"))).toBe(true);
    expect(existsSync(join(stateDir, "settings.json.tmp"))).toBe(false);
  });
});
