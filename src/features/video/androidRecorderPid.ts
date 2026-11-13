/**
 * Device-side process id tracking for the Android `screenrecord` recorder (#9898).
 *
 * Stopping the recorder by name (`pkill screenrecord`) signals every recorder on the
 * device, including ones this recording does not own. Instead the recorder is launched
 * in a detached session when `setsid` is available: the device shell prints its own pid and then
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
 * Builds one `adb shell` command that detaches with `setsid` so a dropped host adb
 * session does not kill the recorder (#17951). Older images without `setsid`, and images
 * whose `setsid` cannot exec (exit 126/127, before the detached shell printed anything),
 * use the attached launch (#18243). The launch shell first ignores SIGHUP: when the host adb
 * client dies while the server stays up, adbd sends the shell SIGHUP, and mksh forwards it
 * to its jobs even across the `setsid` boundary, which stopped the recorder (#18292). In either case the innermost shell prints `$$` before
 * `exec` keeps that pid for `screenrecord`. Tokens must not contain single quotes because
 * the detached shell command is single-quoted; argv otherwise stays space-joined.
 */
export function buildPidReportingScreenrecordArgs(screenrecordArgv: readonly string[]): string[] {
  if (screenrecordArgv.some((arg) => arg.includes("'"))) {
    throw new Error("Android screenrecord argv must not contain single quotes.");
  }
  const command = `echo $$; exec ${screenrecordArgv.join(" ")}`;
  return [
    "shell",
    `trap '' HUP; if command -v setsid >/dev/null 2>&1; then setsid sh -c '${command}'; s=$?; case $s in 126|127) ;; *) exit $s;; esac; fi; ${command}`,
  ];
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

/**
 * One device command that lists every running `screenrecord` with its cmdline, so a
 * recorder whose launch pid was never learned can still be found by its unique output
 * file (#18243). `pidof`'s own status is printed last: 1 means no recorder runs at all,
 * and a missing or other status means the answer is unknown.
 */
export const RECORDER_LOOKUP_COMMAND =
  'shell \'pids=$(pidof screenrecord); s=$?; for p in $pids; do printf "pid:%s:" "$p"; cat /proc/$p/cmdline 2>/dev/null; echo; done; printf "pidof-status:%s\\n" "$s"\'';

/** What {@link RECORDER_LOOKUP_COMMAND} says about the recorder writing one output file. */
export type RecorderLookup =
  | { kind: "found"; pid: number }
  | { kind: "none" }
  | { kind: "unknown" };

/**
 * Parses {@link RECORDER_LOOKUP_COMMAND} output for the recorder writing `deviceTempPath`.
 * "none" is returned only when `pidof` answered and no listed recorder writes that file.
 */
export function parseRecorderLookup(stdout: string, deviceTempPath: string): RecorderLookup {
  const lines = stdout.split(/\r?\n/);
  const status = lines
    .map((line) => /^pidof-status:(\d+)$/.exec(line.trim())?.[1])
    .find((value) => value !== undefined);
  if (status === "1") {
    return { kind: "none" };
  }
  if (status !== "0") {
    return { kind: "unknown" };
  }
  for (const line of lines) {
    const match = /^pid:(\d+):(.*)$/s.exec(line);
    const pid = match ? parsePidLine(match[1]) : undefined;
    if (pid !== undefined && isOwnRecorderCmdline(match?.[2] ?? "", deviceTempPath)) {
      return { kind: "found", pid };
    }
  }
  return { kind: "none" };
}
