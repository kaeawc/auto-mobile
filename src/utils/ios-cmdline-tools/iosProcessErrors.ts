/**
 * Canonical "the app's process was already gone, so terminating it is an
 * effective no-op success" matcher for iOS terminate paths (issue #3076).
 *
 * Both the simulator path (`simctl terminate`, see `TerminateApp`) and the
 * physical-device path (`devicectl device process terminate`, see
 * `DeviceAppManager`) can fail because the target process exited on its own
 * between the moment we resolved it and the moment we tried to kill it. That is
 * not a real failure — the app is gone either way — so the caller reports an
 * effectively-terminated app instead of a false `success:false`.
 *
 * This helper covers only the phrasings shared by both tools. Tool-specific
 * error text (e.g. devicectl's bare `NSPOSIXErrorDomain error 3` ESRCH code)
 * is OR-ed in at the call site rather than re-listed here, so a new shared
 * phrasing is added in exactly one place.
 *
 * Deliberately narrow: unrelated failures (device locked, not connected,
 * permission denied) must still propagate as hard errors. The "not running"
 * family is scoped to the *process* — a device- or CoreDevice-level "not
 * running" must never be mistaken for an already-exited PID, otherwise a
 * disconnected device would masquerade as a terminated app.
 */
export const isProcessAlreadyGoneError = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no such process") || // ESRCH strerror
    normalized.includes("found nothing to terminate") || // simctl "nothing to kill"
    /process (?:is )?not running/.test(normalized)
  ); // process-scoped, not device-scoped
};
