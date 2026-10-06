import { readFileSync } from "node:fs";

/** The package `cmd notification allow_dnd|disallow_dnd` was run against in the captures. */
export const CAPTURED_APP_ID = "dev.jasonpearson.automobile.playground";

export type NotificationPolicyCaptureStep = "before" | "after-allow" | "after-disallow";

/** The two API 36 emulators the captures were taken on. */
export const CAPTURE_EMULATORS = ["emulator-5600", "emulator-5602"] as const;
export type NotificationPolicyCaptureEmulator = (typeof CAPTURE_EMULATORS)[number];

const TRAILER_MARKER = "# lines naming the playground package:";
const GREP_LINE_NUMBER_PREFIX = /^\d+:/;

/** Raw bytes of a captured file under `test/fixtures/android-notification-policy/`. */
export function readNotificationPolicyCaptureFile(
  step: NotificationPolicyCaptureStep,
  emulator: NotificationPolicyCaptureEmulator,
): string {
  return readFileSync(
    new URL(
      `../fixtures/android-notification-policy/dumpsys-notification-policy-${step}-${emulator}.txt`,
      import.meta.url,
    ),
    "utf8",
  );
}

/**
 * The captures are `grep -n` excerpts of `adb shell dumpsys notification`: a `# grep -c ...` header
 * comment, the `Condition providers:` section with each line prefixed `<line number>:`, then a
 * `# lines naming ...` trailer that repeats lines from elsewhere in the dump. The file is not edited;
 * this undoes the grep framing only (drop the two comment blocks, drop the line-number prefix) so
 * the parser sees the section exactly as the device printed it.
 */
export function dumpsysNotificationFromCapture(
  step: NotificationPolicyCaptureStep,
  emulator: NotificationPolicyCaptureEmulator,
): string {
  const raw = readNotificationPolicyCaptureFile(step, emulator);
  const trailer = raw.indexOf(TRAILER_MARKER);
  const body = trailer === -1 ? raw : raw.slice(0, trailer);
  return body
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.replace(GREP_LINE_NUMBER_PREFIX, ""))
    .join("\n");
}
