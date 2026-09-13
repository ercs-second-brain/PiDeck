import { statePaths } from "./stateDir.js";

import {
  GlobalSettingsSchema,
  NotOnboarded,
  type GlobalSettings,
  type GlobalSettingsPut,
  type GlobalSettingsRead,
  type ReviewAccount,
  type ReviewAccountPut,
} from "@pideck/shared";
import { JsonFile } from "./jsonFile.js";

const emptySettings: GlobalSettings = GlobalSettingsSchema.parse({});

/**
 * Global settings persisted at `<stateDir>/settings.json` through the shared
 * contract. Reads are GET-shaped (token masked to `tokenSet`); `reviewToken()`
 * hands the real credentials to the gh client and throws `NotOnboarded` while
 * no review account is configured — the workflow requires one. The review
 * account is saved both-or-neither (a username without any token is rejected)
 * and can be replaced but never cleared.
 */
export class GlobalSettingsStore {
  private file: JsonFile<GlobalSettings>;

  constructor(stateDir: string) {
    this.file = new JsonFile(statePaths(stateDir).settingsFile, GlobalSettingsSchema, emptySettings);
    this.file.load();
  }

  /** False only before onboarding completes: no review account is stored. */
  onboarded(): boolean {
    return this.file.load().reviewAccount !== null;
  }

  reviewToken(): ReviewAccount {
    const account = this.file.load().reviewAccount;
    if (account === null) throw new NotOnboarded();
    return { ...account };
  }

  read(): GlobalSettingsRead {
    const settings = this.file.load();
    return {
      reviewAccount: settings.reviewAccount
        ? { username: settings.reviewAccount.username, tokenSet: true }
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
      settings.reviewAccount = reviewAccountFrom(patch.reviewAccount, settings.reviewAccount);
    }
    if (patch.modelByPersona !== undefined) {
      settings.modelByPersona = { ...settings.modelByPersona, ...patch.modelByPersona };
    }
    this.file.write(settings);
  }
}

function reviewAccountFrom(put: ReviewAccountPut, existing: ReviewAccount | null): ReviewAccount {
  const token = put.token ?? existing?.token;
  if (!token) {
    throw new Error("review account needs a username and a token, both or neither");
  }
  return { username: put.username, token };
}