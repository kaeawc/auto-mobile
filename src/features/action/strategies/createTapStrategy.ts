import type { BootedDevice } from "../../../models";
import type { AccessibilityDetector } from "../../../utils/interfaces/AccessibilityDetector";
import type { IosVoiceOverDetector } from "../../../utils/interfaces/IosVoiceOverDetector";
import type { TapStrategy } from "../../../utils/interfaces/TapStrategy";
import { AndroidTapStrategy } from "./AndroidTapStrategy";
import { IosTapStrategy } from "./IosTapStrategy";

/**
 * Build the platform-appropriate {@link TapStrategy} for `device`.
 *
 * Centralising the selection here keeps `TapOnElement.ts` free of
 * platform branches: it asks the factory for a strategy and never
 * inspects `device.platform` itself.
 */
export function createTapStrategy(
  device: BootedDevice,
  accessibilityDetector: AccessibilityDetector,
  iosVoiceOverDetector: IosVoiceOverDetector
): TapStrategy {
  if (device.platform === "ios") {
    return new IosTapStrategy(iosVoiceOverDetector);
  }
  return new AndroidTapStrategy(accessibilityDetector);
}
