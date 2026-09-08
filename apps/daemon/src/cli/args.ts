/**
 * CLI argument parsing (dependency-free).
 *
 * Grammar: `pideck <command...> [--flag value | --flag=value | --bool]...`
 * Flags are collected into a record; `--json` and repeated flags become
 * booleans / arrays respectively. `--` stops flag parsing.
 */

export interface ParsedArgs {
  /** All non-flag arguments in order (command path + trailing positionals). */
  positionals: string[];
  /** Parsed flags; `--json` → `true`, `--flag v` → `"v"`, repeats → arrays. */
  flags: Record<string, string | boolean | string[]>;
  /** Raw argv (post-`node`/bin). */
  argv: string[];
}

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number = 2) {
    super(message);
    this.name = "CliError";
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionalList: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  const set = (key: string, value: string | boolean): void => {
    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      flags[key] = [String(existing), String(value)];
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      for (let j = i + 1; j < argv.length; j++) positionalList.push(argv[j] as string);
      break;
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          set(arg.slice(2), next);
          i++;
        } else {
          set(arg.slice(2), true);
        }
      }
      continue;
    }
    positionalList.push(arg);
  }
  return { flags, positionals: positionalList, argv };
}

/** Requires a flag; throws a CliError with usage text when missing. */
export function requireFlag(flags: Record<string, string | boolean | string[]>, name: string, usage?: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`missing required flag --${name}${usage !== undefined ? `\n\nUsage: ${usage}` : ""}`);
  }
  return value;
}

/** Optional string flag. */
export function optionalFlag(flags: Record<string, string | boolean | string[]>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The first `n` positionals (the command path); returns undefined when short. */
export function positional(parsed: ParsedArgs, index: number): string | undefined {
  return parsed.positionals[index];
}
