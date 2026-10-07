import { buildSimctlArgs } from "../../../utils/ios-cmdline-tools/simctlArgs";
import { shellQuote } from "../../../utils/shellQuote";
/**
 * Tiny iOS-specific helpers shared between `SystemConfigurationManager`
 * (for its iOS-only public methods like `restartSpringBoard`) and
 * `IosSystemConfigurationAdapter` (for its locale/timezone/24h ops).
 */

import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";

/**
 * Read the iOS device backend kind. Many system-configuration writes only work on
 * the Simulator, so callers gate on this.
 */
export function isIosSimulator(deviceId: string): boolean {
  return resolveIosDeviceKind({ deviceId: deviceId }) === "simulator";
}

/** Compose an `xcrun simctl spawn <udid> <command>` shell line. */
export function iosSpawnCommand(deviceId: string, command: string): string {
  const args = buildSimctlArgs(["spawn", deviceId]);
  // Preserve the existing shell fragment; quote only the newly injected path.
  if (args[1] === "--set") {
    args[2] = shellQuote(args[2]);
  }
  return `xcrun ${args.join(" ")} ${command}`;
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
