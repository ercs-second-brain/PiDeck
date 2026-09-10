/**
 * Contract test for the daemon-wide settings endpoints (issue #106):
 * GET/PUT /api/settings, toggle updates, contract validation. The store
 * itself is covered in `settings.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, settingsReadSchema } from "@pideck/shared";

import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;

beforeAll(async () => {
  server = await startContractServer();
});

afterAll(async () => {
  await server?.close();
});

describe("settings", () => {
  it("gets and updates daemon-wide settings", async () => {
    const { api } = server;
    const got = await api("GET", endpoints.getSettings.path);
    expect(got.status).toBe(200);
    expect(settingsReadSchema.parse(got.json)).toEqual({
      defaultWorkerConcurrency: 3,
      terminateOnMerge: true,
      autoFixCi: true,
      autoFixReviewComments: true,
      autoReview: true,
      reviewAccountUsername: null,
      reviewAccountTokenConfigured: false,
      browserMergeNotifications: false,
    });

    const updated = await api("PUT", endpoints.updateSettings.path, { defaultWorkerConcurrency: 5 });
    expect(updated.status).toBe(200);
    expect(settingsReadSchema.parse(updated.json)).toEqual({
      defaultWorkerConcurrency: 5,
      terminateOnMerge: true,
      autoFixCi: true,
      autoFixReviewComments: true,
      autoReview: true,
      reviewAccountUsername: null,
      reviewAccountTokenConfigured: false,
      browserMergeNotifications: false,
    });

    // Worker-pipeline toggles (issue #106) update without a restart.
    const toggled = await api("PUT", endpoints.updateSettings.path, { autoFixCi: false });
    expect(toggled.status).toBe(200);
    expect(settingsReadSchema.parse(toggled.json).autoFixCi).toBe(false);
    await api("PUT", endpoints.updateSettings.path, { autoFixCi: true });

    // invalid values → 400 (contract validation)
    expect((await api("PUT", endpoints.updateSettings.path, { defaultWorkerConcurrency: 99 })).status).toBe(400);
    expect((await api("PUT", endpoints.updateSettings.path, { terminateOnMerge: "nope" })).status).toBe(400);

    // Issue #424 (F2): the review-account pair is both-or-neither — half a
    // second identity is not a configurable state.
    expect((await api("PUT", endpoints.updateSettings.path, { reviewAccountToken: "ghp_review" })).status).toBe(400);
    expect((await api("PUT", endpoints.updateSettings.path, { reviewAccountUsername: "review-bot" })).status).toBe(400);

    // Issue #428 (F12): MASK-ON-READ — once a token is stored, GET and PUT
    // responses carry only the configured flag; the raw token never appears
    // in any response body (the PUT below stores a recognizable raw token
    // and the responses must not echo it back in any shape).
    const paired = await api("PUT", endpoints.updateSettings.path, { reviewAccountToken: "ghp_secret_428", reviewAccountUsername: "review-bot" });
    expect(paired.status).toBe(200);
    expect(settingsReadSchema.parse(paired.json)).toMatchObject({ reviewAccountUsername: "review-bot", reviewAccountTokenConfigured: true });
    expect(JSON.stringify(paired.json)).not.toContain("ghp_secret_428");
    const gotConfigured = await api("GET", endpoints.getSettings.path);
    expect(settingsReadSchema.parse(gotConfigured.json)).toMatchObject({ reviewAccountUsername: "review-bot", reviewAccountTokenConfigured: true });
    expect(JSON.stringify(gotConfigured.json)).not.toContain("ghp_secret_428");

    // Clearing the account: both halves together (both-or-neither), and the
    // response drops back to not-configured.
    const cleared = await api("PUT", endpoints.updateSettings.path, { reviewAccountToken: null, reviewAccountUsername: null });
    expect(cleared.status).toBe(200);
    expect(settingsReadSchema.parse(cleared.json)).toMatchObject({ reviewAccountUsername: null, reviewAccountTokenConfigured: false });

    // reset
    await api("PUT", endpoints.updateSettings.path, { defaultWorkerConcurrency: 3 });
  });
});
