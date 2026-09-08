/**
 * Shared compact timestamp formatter for worker/PR cards ("Jan 5, 14:03").
 * Falls back to the raw input when the value isn't a parseable date.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Human-scaled running-time label for sidebar worker rows (issue #182):
 * seconds under a minute, minutes under an hour, hours under a day, days
 * beyond that. `nowMs` (epoch ms) is injectable so tests stay deterministic
 * and archived rows can freeze the span at their final `updatedAt`; empty
 * string for unparseable input.
 */
export function formatRunningDuration(startedAtIso: string, nowMs: number = Date.now()): string {
  const started = Date.parse(startedAtIso);
  if (Number.isNaN(started)) return "";
  const seconds = Math.max(0, Math.floor((nowMs - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
