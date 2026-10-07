import { wrapCommandError } from "../../src/utils/CommandError";

export interface AdbRejectionShape {
  /** Arguments after the `adb` binary, as the command line that was run. */
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The rejection a real AdbClient produces for a command that exits non-zero: node's raw
 * execFile error (carrying `stdout`/`stderr`/`code`, and a message that is the command line
 * followed by stderr) wrapped by `wrapCommandError`, which keeps the raw error as `cause`,
 * puts nothing on the top-level error but a formatted message, and echoes the command line
 * (and so any package name or APK path) in it.
 */
export function wrappedAdbRejection(shape: AdbRejectionShape): Error {
  const commandLine = ["adb", ...shape.args].join(" ");
  const raw = Object.assign(
    new Error(`Command failed: ${commandLine}${shape.stderr ? `\n${shape.stderr}` : ""}`),
    { code: shape.exitCode, stdout: shape.stdout, stderr: shape.stderr },
  );
  return wrapCommandError(raw, { command: "adb", args: shape.args });
}
