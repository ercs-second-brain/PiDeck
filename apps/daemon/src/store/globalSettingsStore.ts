import { join } from "node:path";
import {
  GlobalSettingsSchema,
  type GlobalSettings,
  type GlobalSettingsPut,
  type GlobalSettingsRead,
  type Persona,
  type ReviewAccount,
  type ReviewAccountPut,
} from "@pideck/shared";
import { JsonFile } from "./jsonFile.js";

const emptySettings: GlobalSettings = GlobalSettingsSchema.parse({});

/**
 * Global settings persisted at `<stateDir>/settings.json` through the shared
 * contract. Reads are GET-shaped (token masked to `tokenSet`); `reviewToken()`
 * hands the real credentials to the gh client. The review account is saved
 * both-or-neither: a username without any token is rejected.
 */
export class GlobalSettingsStore {
  private file: JsonFile<GlobalSettings>;

  constructor(stateDir: string) {
    this.file = new JsonFile(join(stateDir, "settings.json"), GlobalSettingsSchema, emptySettings);
    this.file.load();
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

  reviewToken(): ReviewAccount | null {
    const account = this.file.load().reviewAccount;
    return account ? { ...account } : null;
  }

  put(patch: GlobalSettingsPut): void {
    const settings = this.file.load();
    if (patch.reviewAccount !== undefined) {
      settings.reviewAccount = reviewAccountFrom(patch.reviewAccount, settings.reviewAccount);
    }
    if (patch.modelByPersona !== undefined) {
      settings.modelByPersona = { ...settings.modelByPersona, ...patch.modelByPersona };
    }
    this.file.write(settings);
  }

  setModel(persona: Persona, model: string | null): void {
    const settings = this.file.load();
    settings.modelByPersona = { ...settings.modelByPersona, [persona]: model };
    this.file.write(settings);
  }
}

function reviewAccountFrom(
  put: ReviewAccountPut | null,
  existing: ReviewAccount | null,
): ReviewAccount | null {
  if (!put) return null;
  const token = put.token ?? existing?.token;
  if (!token) {
    throw new Error("review account needs a username and a token, both or neither");
  }
  return { username: put.username, token };
}
