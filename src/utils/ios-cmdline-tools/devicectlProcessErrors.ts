import { errorMessage } from "../describeUnknownError";
import { isProcessAlreadyGoneError } from "./iosProcessErrors";

/**
 * Full text of a failed `exec` rejection. Promisified `child_process.exec`
 * rejects with an Error whose `message` is "Command failed: <cmd>" and whose
 * `stdout`/`stderr` carry the tool's actual diagnostic — devicectl writes its
 * ESRCH "No such process" text to stderr, so we must inspect the captured
 * streams, not just message. stdout is included as a cheap belt-and-suspenders:
 * with `--quiet` devicectl uses stderr, but its error framing is undocumented.
 */
export const getExecErrorText = (error: unknown): string => {
  const parts = [errorMessage(error)];
  if (error && typeof error === "object") {
    for (const field of ["stderr", "stdout"] as const) {
      const value = (error as Record<string, unknown>)[field];
      if (typeof value === "string" && value.length > 0) {
        parts.push(value);
      }
    }
  }
  return parts.join("\n");
};

/**
 * True when a devicectl `process terminate` failure means the target PID was
 * already gone — it exited between our `info processes` resolution and the kill
 * (a real on-device race, issue #3054). devicectl surfaces ESRCH either as the
 * localized "No such process" strerror text or, on some builds, the bare
 * `NSPOSIXErrorDomain error 3` code without the strerror gloss.
 *
 * The shared already-gone phrasings live in {@link isProcessAlreadyGoneError}
 * (used by the simulator path too, issue #3076); here we OR-in the two
 * devicectl-specific extras so a raced exit reports an effectively-terminated
 * app instead of a false `success:false`. Together these preserve the exact
 * prior devicectl behavior: shared `not running` ∪ extra `no longer running`.
 *
 * Deliberately narrow: unrelated failures (device locked, not connected,
 * permission denied) must still propagate as hard errors. The "not running"
 * family is scoped to the *process* so a device/CoreDevice-level "not running"
 * message can never be mistaken for an already-exited PID.
 */
export const isDevicectlProcessGoneError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    isProcessAlreadyGoneError(message) ||
    normalized.includes("nsposixerrordomain error 3") || // bare ESRCH code
    /process (?:is )?no longer running/.test(normalized)
  ); // devicectl-only phrasing
};
