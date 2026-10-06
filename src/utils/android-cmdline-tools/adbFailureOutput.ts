const ADB_FAILURE_CAUSE_DEPTH = 5;

function outputText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return Buffer.isBuffer(value) ? value.toString() : "";
}

/**
 * The command's own stdout/stderr carried by a rejected adb call, found by walking `cause`.
 * A real `AdbClient` rejection is `wrapCommandError`'s new `Error` (the streams are formatted
 * into its message and kept on `cause`, the raw execFile error), so reading `stdout`/`stderr`
 * off the top-level error alone finds nothing. `adb shell` also propagates the remote exit
 * status, so a failing remote command rejects the call and its text arrives here rather than
 * in a resolved result. The error `message` is never read, because it echoes the command line
 * and so package names and APK paths.
 */
export function adbFailureOutput(error: unknown): { stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < ADB_FAILURE_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const streams = current as Error & { stdout?: unknown; stderr?: unknown };
    stdout.push(outputText(streams.stdout));
    stderr.push(outputText(streams.stderr));
    current = current.cause;
  }
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}
