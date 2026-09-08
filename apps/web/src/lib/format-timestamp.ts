/**
 * Shared compact timestamp formatter for worker/PR cards ("Jan 5, 14:03").
 * Falls back to the raw input when the value isn't a parseable date.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
