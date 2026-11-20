import { commandFailureDetails } from "../CommandError";

/** Read the remote command's streams from a rejected adb call. */
export function adbFailureOutput(error: unknown): { stdout: string; stderr: string } {
  const { stdout, stderr } = commandFailureDetails(error);
  return { stdout, stderr };
}

/** A clean `pidof` miss in a raw execFile rejection or an adb command wrapper. */
export function isPidofNoMatch(error: unknown): boolean {
  // wrapCommandError keeps the raw exit status and streams on cause.
  const failure = error instanceof Error && !("code" in error) ? error.cause : error;
  if (typeof failure !== "object" || failure === null) {
    return false;
  }
  const { code, stdout, stderr } = failure as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const empty = (value: unknown) => value === undefined || String(value).trim().length === 0;
  return code === 1 && empty(stdout) && empty(stderr);
}
