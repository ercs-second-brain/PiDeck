import { readFileSync } from "node:fs";

import { statePaths } from "./stateDir.js";

import {
  GlobalSettingsSchema,
  NotOnboarded,
  type GlobalSettingsPut,
  type GlobalSettingsRead,
  type ReviewAccount,
} from "@pideck/shared";
import { z } from "zod";
import { JsonFile } from "./jsonFile.js";

/**
 * settings.json holds no secrets — agents run as the daemon's user and the
 * settings file is the first path they try, so it carries the review account's
 * username only. The token lives in its own 0600 file that the settings
 * contract never describes.
 */
const StoredSettingsSchema = GlobalSettingsSchema.extend({
  reviewAccount: z.object({ username: z.string().min(1) }).nullable().default(null),
});

const ReviewTokenFileSchema = z.object({ token: z.string().min(1).optional() });

type StoredSettings = z.infer<typeof StoredSettingsSchema>;

const emptySettings: StoredSettings = StoredSettingsSchema.parse({});
const emptyTokenFile: z.infer<typeof ReviewTokenFileSchema> = ReviewTokenFileSchema.parse({});

/**
 * Global settings persisted at `<stateDir>/settings.json` through the shared
 * contract. Reads are GET-shaped (token masked to `tokenSet`); `reviewToken()`
 * hands the real credentials to the gh client and throws `NotOnboarded` while
 * no review account is configured — the workflow requires one. The review
 * account is saved both-or-neither (a username without any token is rejected)
 * and can be replaced but never cleared. The token itself is written to
 * `<stateDir>/review-token.json`, never into settings.json.
 */
export class GlobalSettingsStore {
  private file: JsonFile<StoredSettings>;
  private tokenFile: JsonFile<{ token?: string }>;

  constructor(stateDir: string) {
    const paths = statePaths(stateDir);
    this.file = new JsonFile(paths.settingsFile, StoredSettingsSchema, emptySettings);
    this.tokenFile = new JsonFile(paths.reviewTokenFile, ReviewTokenFileSchema, emptyTokenFile);
    this.migrateTokenOutOfSettings();
    this.file.load();
  }

  /** False only before onboarding completes: no review account is stored. */
  onboarded(): boolean {
    return this.tokenPresent() && this.file.load().reviewAccount !== null;
  }

  reviewToken(): ReviewAccount {
    const account = this.file.load().reviewAccount;
    const token = this.tokenFile.load().token;
    if (account === null || token === undefined) throw new NotOnboarded();
    return { username: account.username, token };
  }

  read(): GlobalSettingsRead {
    const settings = this.file.load();
    return {
      reviewAccount: settings.reviewAccount
        ? { username: settings.reviewAccount.username, tokenSet: this.tokenPresent() }
        : null,
      modelByPersona: { ...settings.modelByPersona },
    };
  }

  put(patch: GlobalSettingsPut): void {
    const settings = this.file.load();
    if (patch.reviewAccount !== undefined) {
      if (patch.reviewAccount === null) {
        throw new Error("the review account is required — it can be replaced but not cleared");
      }
      if (patch.reviewAccount.token === undefined) {
        // A save without a token keeps the one already on file.
        if (!this.tokenPresent()) {
          throw new Error("review account needs a username and a token, both or neither");
        }
      } else {
        this.tokenFile.write({ token: patch.reviewAccount.token });
      }
      settings.reviewAccount = { username: patch.reviewAccount.username };
    }
    if (patch.modelByPersona !== undefined) {
      settings.modelByPersona = { ...settings.modelByPersona, ...patch.modelByPersona };
    }
    this.file.write(settings);
  }

  private tokenPresent(): boolean {
    return this.tokenFile.load().token !== undefined;
  }

  /**
   * Early installs carried the token inside settings.json, and onboard.sh
   * still writes that shape. A plain parse would silently strip the field, so
   * the raw document is inspected first: the token moves to its own file and
   * settings.json is rewritten without it.
   */
  private migrateTokenOutOfSettings(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file.path, "utf8");
    } catch {
      return;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      return; // load() reports a corrupt file with its path
    }
    const legacy = (doc as { reviewAccount?: { token?: unknown } }).reviewAccount?.token;
    if (typeof legacy !== "string" || legacy === "") return;
    this.tokenFile.write({ token: legacy });
    const settings = this.file.load();
    this.file.write({
      ...settings,
      reviewAccount:
        settings.reviewAccount === null ? null : { username: settings.reviewAccount.username },
    });
  }
}
