import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PD_HOME?.trim();
  return fromEnv ? resolve(fromEnv) : join(homedir(), ".pideck");
}
