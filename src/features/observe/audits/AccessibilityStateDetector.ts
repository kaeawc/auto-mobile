import { logger } from "../../../utils/logger";
import { throwIfAborted } from "../../../utils/toolUtils";
import { accessibilityDetector } from "../../../utils/AccessibilityDetector";
import { iosVoiceOverDetector } from "../../../utils/IosVoiceOverDetector";
import { FeatureFlagService } from "../../featureFlags/FeatureFlagService";
import { IOSCtrlProxyClient } from "../ios";
import type { BootedDevice, ObserveResult } from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";

export interface AccessibilityStateDetectorOptions {
  device: BootedDevice;
  adb: AdbExecutor;
}

/**
 * Detects accessibility state (TalkBack on Android, VoiceOver on iOS) and
 * attaches it to the ObserveResult. Failures are logged but do not propagate.
 */
export class AccessibilityStateDetector {
  private readonly device: BootedDevice;
  private readonly adb: AdbExecutor;

  constructor(opts: AccessibilityStateDetectorOptions) {
    this.device = opts.device;
    this.adb = opts.adb;
  }

  async run(result: ObserveResult, perf: PerformanceTracker, signal?: AbortSignal): Promise<void> {
    try {
      await perf.track("accessibilityDetection", async () => {
        throwIfAborted(signal);

        // Get feature flag service instance
        const featureFlags = FeatureFlagService.getInstance();

        if (this.device.platform === "android") {
          // Detect TalkBack state via ADB
          const enabled = await accessibilityDetector.isAccessibilityEnabled(
            this.device.deviceId,
            this.adb,
            featureFlags,
          );

          const service = await accessibilityDetector.detectMethod(
            this.device.deviceId,
            this.adb,
            featureFlags,
          );

          result.accessibilityState = { enabled, service };
          logger.debug(
            `[AccessibilityDetector] Android accessibility state: enabled=${enabled}, service=${service}`,
          );
        } else if (this.device.platform === "ios") {
          // Detect VoiceOver state via CtrlProxy WebSocket
          const client = IOSCtrlProxyClient.getInstance(this.device);
          const enabled = await iosVoiceOverDetector.isVoiceOverEnabled(
            this.device.deviceId,
            client,
            featureFlags,
          );

          result.accessibilityState = {
            enabled,
            service: enabled ? "voiceover" : "unknown",
          };
          logger.debug(`[IosVoiceOverDetector] iOS VoiceOver state: enabled=${enabled}`);
        }
      });
    } catch (error) {
      logger.error(`[detectAccessibilityState] Failed to detect accessibility state: ${error}`);
      // Don't fail the entire observation if detection fails
      // Result will simply not include accessibilityState field
    }
  }
}
