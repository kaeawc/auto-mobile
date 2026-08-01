import { homedir } from "node:os";

/**
 * Replaces a leading home-directory prefix in a path with `~` so diagnostic
 * logs don't leak the local username. Only the home prefix is redacted; the
 * remainder of the path is preserved so the trace stays actionable.
 *
 * @param value - Path (or message containing a path) to redact.
 * @param home - Home directory to anchor the redaction on (injectable for tests).
 */
export function redactHomeDir(value: string, home: string = homedir()): string {
  if (home.length > 0 && value.startsWith(home)) {
    return "~" + value.slice(home.length);
  }
  return value;
}
