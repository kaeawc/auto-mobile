import type { BootedDevice } from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { AccessibilityDetector } from "../../../utils/interfaces/AccessibilityDetector";
import type { IosVoiceOverDetector } from "../../../utils/interfaces/IosVoiceOverDetector";
import type { TapStrategy } from "../../../utils/interfaces/TapStrategy";
import type { FeatureFlagService } from "../../featureFlags/FeatureFlagService";
import { AndroidTapStrategy } from "./AndroidTapStrategy";
import { IosTapStrategy } from "./IosTapStrategy";

/**
 * Build the platform-appropriate {@link TapStrategy} for `device`.
 * Centralising the selection here keeps `TapOnElement.ts` free of
 * platform branches.
 */
export function createTapStrategy(
  device: BootedDevice,
  adb: AdbExecutor,
  accessibilityDetector: AccessibilityDetector,
  iosVoiceOverDetector: IosVoiceOverDetector,
  featureFlags?: FeatureFlagService,
): TapStrategy {
  if (device.platform === "ios") {
    return new IosTapStrategy(device, iosVoiceOverDetector, featureFlags);
  }
  return new AndroidTapStrategy(device, adb, accessibilityDetector, featureFlags);
}
