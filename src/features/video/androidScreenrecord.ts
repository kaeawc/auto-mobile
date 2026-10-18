/**
 * Android `adb shell screenrecord` enforces a maximum `--time-limit` of 180 seconds.
 * @see https://developer.android.com/studio/command-line/adb#screenrecord
 */
export const ANDROID_SCREENRECORD_MAX_SECONDS = 180;

/**
 * For long plan runs, start a new segment after this many milliseconds so the next
 * `screenrecord` begins before the device hits {@link ANDROID_SCREENRECORD_MAX_SECONDS}.
 */
export const ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS = 170_000;

/** Device-command and exit-wait budgets for the screenrecord capture backend. */
export const SCREENRECORD_MS = {
  // Waiting for the host-side recorder process to exit after a graceful stop request.
  gracefulExit: 10000,
  // `pkill` of the on-device screenrecord process (SIGINT or SIGKILL).
  pkill: 8000,
  // Removing the on-device temp recording file.
  tempFileRemove: 8000,
  // Quick read-only device probes (`stat` of the recording, `pidof screenrecord`).
  probe: 5000,
  // Exec options for `pkill`.
  pkillOpts: { timeoutMs: 8000 },
} as const;
