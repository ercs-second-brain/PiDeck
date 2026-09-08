/**
 * Onboarding state endpoint (`GET /api/onboarding`, issue #165): the ONE
 * daemon-side source of truth for onboarding state, shared by the shell
 * installer and the webapp wizard so a step the shell onboarding completed
 * is never re-asked.
 *
 * Combines:
 * - the installer's recorded results (`<stateDir>/onboarding.json`, written
 *   by install/onboard.sh) — `recorded` is null when the shell onboarding
 *   never ran or its file is unparseable;
 * - the live pi-auth probe (same payload as `GET /api/pi-auth`, issue #57);
 * - the live gh-auth probe (same payload as `GET /api/gh-auth`).
 *
 * Non-contract route like `/api/pi-auth` and `/api/gh-auth`: a daemon-side
 * capability probe, not a resource API — the *shape* is contracted in the
 * shared package (`onboardingStateSchema`) so the webapp cannot drift.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  onboardingRecordSchema,
  onboardingStateSchema,
  type OnboardingRecord,
  type OnboardingState,
} from "@pideck/shared";

import type { DaemonServices } from "./context.js";
import { ghAuthPayload } from "./gh-auth.js";
import type { GhClient } from "../github/index.js";
import { Router } from "./router.js";

/**
 * Lenient shape of the installer-written onboarding.json: extra keys
 * tolerated, blank/absent optional strings default to "" and are
 * normalized to null by {@link readRecordedOnboarding}.
 */
const recordFileSchema = z.object({
  onboardedAt: z.string(),
  pi: z
    .object({
      authStatus: z.string().default("none"),
      provider: z.string().optional().default(""),
      model: z.string().optional().default(""),
    })
    .loose(),
  gh: z
    .object({
      authStatus: z.string().default("none"),
      user: z.string().optional().default(""),
      canCreateRepo: z.boolean().optional(),
    })
    .loose(),
});

const orNull = (value: string): string | null => (value.length > 0 ? value : null);

/** Reads + normalizes the installer's onboarding.json; null when absent or unparseable. */
export function readRecordedOnboarding(stateDir: string): OnboardingRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(stateDir, "onboarding.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
  const parsed = recordFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { onboardedAt, pi, gh } = parsed.data;
  return onboardingRecordSchema.parse({
    onboardedAt,
    pi: { authStatus: pi.authStatus, provider: orNull(pi.provider), model: orNull(pi.model) },
    gh: { authStatus: gh.authStatus, user: orNull(gh.user), canCreateRepo: gh.canCreateRepo ?? null },
  });
}

/** The combined onboarding state payload backing `GET /api/onboarding`. */
export async function onboardingStatePayload(services: DaemonServices, gh?: GhClient): Promise<OnboardingState> {
  const [piAuth, ghAuth] = await Promise.all([services.piAuth.payload(), ghAuthPayload(gh)]);
  return onboardingStateSchema.parse({
    recorded: readRecordedOnboarding(services.stateDir),
    piAuth,
    ghAuth,
  });
}

/** Mounts `GET /api/onboarding` on the router. */
export function registerOnboardingRoute(router: Router, services: DaemonServices): void {
  router.add("GET", "/api/onboarding", () => onboardingStatePayload(services).then((body) => ({ body })));
}
