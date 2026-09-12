/**
 * The one error-to-message rule used across daemon, CLI and web UI: an
 * Error contributes its message, anything else is stringified.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}