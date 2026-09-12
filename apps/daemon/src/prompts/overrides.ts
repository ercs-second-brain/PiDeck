import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Persona } from "@pideck/shared";

type PromptStore = Partial<Record<Persona, string>>;

export class PromptOverrides {
  readonly #file: string;

  constructor(stateDir: string) {
    this.#file = join(stateDir, "prompts.json");
  }

  get(persona: Persona): string | null {
    return this.#read()[persona] ?? null;
  }

  set(persona: Persona, text: string): void {
    const store = this.#read();
    store[persona] = text;
    this.#write(store);
  }

  reset(persona: Persona): void {
    const store = this.#read();
    delete store[persona];
    this.#write(store);
  }

  #read(): PromptStore {
    if (!existsSync(this.#file)) return {};
    return JSON.parse(readFileSync(this.#file, "utf8")) as PromptStore;
  }

  #write(store: PromptStore): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, JSON.stringify(store, null, 2) + "\n");
  }
}