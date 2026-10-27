import { isAdbMissingDeviceError, isAdbDeviceOfflineError } from "./AdbDeviceHealth";

export function isSafeToRetryCommand(commandArgs: string[], hasDispatchGuard: boolean): boolean {
  if (commandArgs[0] === "shell") {
    const payload = commandArgs.slice(1).join(" ").trim();
    // Keep shell metacharacters out: a read-looking prefix can execute a
    // second, mutating command through the device shell.
    if (/[;&`$<>\r\n]/.test(payload)) {
      return false;
    }
    // gfxinfo's reset argument clears counters, unlike its ordinary reads.
    if (/^dumpsys gfxinfo\b[^|]*\breset\b/.test(payload)) {
      return false;
    }
    if (
      /^dumpsys (?:window|activity (?:activities|processes)|display|SurfaceFlinger|package|notification|accessibility|meminfo|gfxinfo|user|power|input_method)\b(?: [^|]+)?(?: \| (?:grep|head) (?:"[^"]*"|'[^']*'|[^|"'`$\r\n])+)*$/.test(
        payload,
      )
    ) {
      return true;
    }
    if (payload.includes("|")) {
      return false;
    }
    return [
      /^(?:getprop|echo)(?: [\w. -]+)?$/,
      /^wm (?:size|density)$/,
      /^settings get [^\s]+ [^\s]+$/,
      /^pm (?:list packages|path)\b(?: .+)?$/,
      /^cmd package (?:query-activities|query-receivers|resolve-activity)\b(?: .+)?$/,
      /^cat \/proc\/[^\s]+$/,
      /^getevent -p$/,
      /^sha256sum (?:[^\s]+|'[^']+'|"[^"]+")$/,
      /^stat -c %s (?:[^\s]+|'[^']+'|"[^"]+")$/,
    ].some((pattern) => pattern.test(payload));
  }
  // Deleting a named emulator snapshot is idempotent; its caller checks the
  // serial's AVD identity again before every dispatch.
  if (commandArgs[0] === "emu" && hasDispatchGuard) {
    return (
      commandArgs.length === 5 &&
      commandArgs[1] === "avd" &&
      commandArgs[2] === "snapshot" &&
      commandArgs[3] === "del"
    );
  }
  return ["devices", "get-state", "get-serialno", "version"].includes(commandArgs[0] ?? "");
}
export function isPreDispatchError(error: Error): boolean {
  const underlying = error.cause instanceof Error ? error.cause : error;
  if ((underlying as NodeJS.ErrnoException).code === "ENOENT") {
    return true;
  }
  const stderr = (underlying as Error & { stderr?: string | Buffer }).stderr;
  // Node's "Command failed: <args>" and wrapCommandError's formatted text
  // include caller input; only inspect standalone errors or adb stderr.
  const message = (
    stderr
      ? Buffer.isBuffer(stderr)
        ? stderr.toString()
        : stderr
      : underlying.message.startsWith("Command failed:")
        ? ""
        : underlying.message
  )
    .trim()
    .toLowerCase()
    .replace(/^error:\s*/, "");
  if (message.startsWith("executable not found")) {
    return true;
  }
  return ["cannot connect to adb", "cannot connect to daemon", "cannot connect to the daemon"].some(
    (pattern) => message.startsWith(pattern),
  );
}

/** Auth, syntax and unmatched transport refusals must never enter the general retry loop. */
export function isNonRetryableAdbError(error: Error, hasDevice: boolean): boolean {
  const underlying = error.cause instanceof Error ? error.cause : error;
  const stderr = (underlying as Error & { stderr?: string | Buffer }).stderr;
  const message = (
    stderr
      ? Buffer.isBuffer(stderr)
        ? stderr.toString()
        : stderr
      : underlying.message.startsWith("Command failed:")
        ? ""
        : underlying.message
  ).toLowerCase();
  if (isAdbMissingDeviceError(underlying)) {
    return true;
  }
  if (!hasDevice && isAdbDeviceOfflineError(message)) {
    return true;
  }
  const nonRetryablePatterns = [
    "operation cancelled",
    "unauthorized",
    "authentication failed",
    "permission denied",
    "unknown command",
    "invalid argument",
    "syntax error",
    "device not found",
    "no devices",
    "install_failed_version_downgrade",
    "install_failed_update_incompatible",
    "install_parse_failed_no_certificates",
    "install_parse_failed_inconsistent_certificates",
    "install_parse_failed_unexpected_exception",
  ];
  return nonRetryablePatterns.some((pattern) => message.includes(pattern));
}
