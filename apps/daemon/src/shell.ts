/**
 * Single-quotes a value for safe embedding in a POSIX shell command:
 * quotes survive verbatim, and the closing-quote escape sequence reopens
 * the quoted string.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}