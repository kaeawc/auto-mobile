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
