import { readFileSync } from "node:fs";
import type { ObserveResult } from "../../../../src/models";

/**
 * Raw stdout of `observe` on an API 34 AAOS emulator while driving, after `launchApp` of a
 * non-distraction-optimized activity (#18045).
 */
export function readSettingsWhileDrivingObservation(): ObserveResult {
  const stdout = readFileSync(
    new URL(
      "../../../fixtures/automotive/activity-blocking/observe-settings-while-driving.json",
      import.meta.url,
    ),
    "utf8",
  );
  return (JSON.parse(stdout) as { structuredContent: ObserveResult }).structuredContent;
}
