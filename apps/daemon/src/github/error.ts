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

function firstLine(stderr: string): string {
  const line = stderr.trim().split("\n")[0];
  return line === undefined || line === "" ? "unexpected gh output" : line;
}
