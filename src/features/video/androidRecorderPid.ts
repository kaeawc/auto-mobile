/**
 * Device-side process id tracking for the Android `screenrecord` recorder (#9898).
 *
 * Stopping the recorder by name (`pkill screenrecord`) signals every recorder on the
 * device, including ones this recording does not own. Instead the recorder is launched
 * as `echo $$; exec screenrecord ...`: the device shell prints its own pid and then
 * `exec`s into `screenrecord`, which keeps that pid, so the first stdout line of the
 * host `adb shell` process is the recorder's device-side pid.
 */

/** The recorder's device-side pid, filled in once the launch shell has printed it. */
export interface DeviceRecorderPid {
  readonly pid: number | undefined;
}

/** The slice of a Readable that the pid reader needs. */
export interface PidOutputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

// A pid line is a handful of digits; anything longer than this without a newline is
// not one, so stop buffering instead of growing without bound.
const MAX_PID_LINE_LENGTH = 32;

/**
 * Builds the single `adb shell` command string that prints the device shell's pid and
 * then replaces the shell with `screenrecord`. `$$` is expanded by the device shell
 * (adb passes the string through verbatim); `exec` keeps the pid.
 */
export function buildPidReportingScreenrecordArgs(screenrecordArgv: readonly string[]): string[] {
  return ["shell", `echo $$; exec ${screenrecordArgv.join(" ")}`];
}

function parsePidLine(line: string): number | undefined {
  const trimmed = line.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Reads the pid from the first stdout line of the launch process. The stream keeps
 * being consumed afterwards (and discarded) so an unread pipe can never back up the
 * recorder. A first line that is not a pid leaves the pid unknown.
 */
export function trackDeviceRecorderPid(stdout: PidOutputStream): DeviceRecorderPid {
  const tracker: { pid: number | undefined } = { pid: undefined };
  let buffered = "";
  let settled = false;
  stdout.on("data", (chunk) => {
    if (settled) {
      return;
    }
    buffered += chunk.toString();
    const newline = buffered.indexOf("\n");
    if (newline === -1 && buffered.length <= MAX_PID_LINE_LENGTH) {
      return;
    }
    settled = true;
    tracker.pid = parsePidLine(newline === -1 ? buffered : buffered.slice(0, newline));
  });
  return tracker;
}

/**
 * True when `/proc/<pid>/cmdline` (NUL-separated argv; whitespace is tolerated too) still describes OUR recorder:
 * `screenrecord` writing to this recording's unique device file. Empty output (the
 * process is gone, or the pid now belongs to something this shell user cannot read)
 * is not ours, so a reused pid is never signalled.
 */
export function isOwnRecorderCmdline(cmdline: string, deviceTempPath: string): boolean {
  const argv = cmdline.split(/[\0\s]+/).filter((part) => part.length > 0);
  return (
    argv.length > 0 &&
    (argv[0] === "screenrecord" || argv[0].endsWith("/screenrecord")) &&
    argv.includes(deviceTempPath)
  );
}
