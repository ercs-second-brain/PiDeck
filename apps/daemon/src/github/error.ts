export class GhError extends Error {
  readonly command: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(command: string, stderr: string, exitCode: number | null) {
    super(`gh ${command} failed${exitCode === null ? "" : ` (exit ${exitCode})`}: ${firstLine(stderr)}`);
    this.name = "GhError";
    this.command = command;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/** A GitHub primary or secondary rate limit; the caller should wait until resetAt. */
export class GhRateLimited extends Error {
  readonly resetAt: Date | null;

  constructor(resetAt: Date | null, stderr: string) {
    super(
      `gh is rate limited${resetAt === null ? "" : ` until ${resetAt.toISOString()}`}: ${firstLine(stderr)}`,
    );
    this.name = "GhRateLimited";
    this.resetAt = resetAt;
  }
}

const RESET_AT = /try again at (\S+)/i;

/**
 * Recognises a GitHub rate limit in gh's stderr — HTTP 403 with the rate-limit
 * message or `X-RateLimit-Remaining: 0`, the secondary-rate-limit wording, or
 * HTTP 429 — and returns the typed error, or null for any other failure.
 */
export function rateLimitError(stderr: string): GhRateLimited | null {
  const lowered = stderr.toLowerCase();
  const limited =
    lowered.includes("http 429") ||
    lowered.includes("x-ratelimit-remaining: 0") ||
    lowered.includes("secondary rate limit") ||
    lowered.includes("rate limit exceeded") ||
    (lowered.includes("http 403") && lowered.includes("rate limit"));
  if (!limited) return null;
  const match = RESET_AT.exec(stderr);
  const resetAt = match === null ? null : new Date(match[1]!);
  return new GhRateLimited(resetAt !== null && !Number.isNaN(resetAt.getTime()) ? resetAt : null, stderr);
}

function firstLine(stderr: string): string {
  const line = stderr.trim().split("\n")[0];
  return line === undefined || line === "" ? "unexpected gh output" : line;
}
