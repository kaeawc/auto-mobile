/**
 * Tiny iOS-specific helpers shared between `SystemConfigurationManager`
 * (for its iOS-only public methods like `restartSpringBoard`) and
 * `IosSystemConfigurationAdapter` (for its locale/timezone/24h ops).
 */

import { isIosSimulatorUdid } from "../../../utils/ios-cmdline-tools/iosDeviceType";

/**
 * Distinguish an iOS Simulator (8-4-4-4-12 UUID) from a physical iPhone
 * (e.g. `00008130-…`). Many system-configuration writes only work on
 * the Simulator, so callers gate on this.
 */
export function isIosSimulator(deviceId: string): boolean {
  return isIosSimulatorUdid(deviceId);
}

/** Compose an `xcrun simctl spawn <udid> <command>` shell line. */
export function iosSpawnCommand(deviceId: string, command: string): string {
  return `xcrun simctl spawn ${deviceId} ${command}`;
}

/**
 * Apple's `AppleLanguages` array prefers fallback chains
 * (e.g. `["zh-Hans-CN", "zh-Hans", "zh"]`) so progressively-broader
 * locales are picked up when an app lacks an exact-match resource.
 */
export function buildAppleLanguages(languageTag: string): string[] {
  const languages: string[] = [languageTag];
  const parts = languageTag.split("-");
  for (let i = parts.length - 1; i >= 1; i--) {
    const shorter = parts.slice(0, i).join("-");
    if (!languages.includes(shorter)) {
      languages.push(shorter);
    }
  }
  return languages;
}

/**
 * Apple's `defaults` writes for the 24-hour-format key surface as `"1"`
 * (24h) or `"0"` (12h) when read back. Normalize to the same `"24"` /
 * `"12"` shape that {@link normalizeTimeFormat} expects.
 */
export function parseAppleTimeFormatRaw(raw: string | null): string | null {
  if (raw === "1") {
    return "24";
  }
  if (raw === "0") {
    return "12";
  }
  return raw;
}
