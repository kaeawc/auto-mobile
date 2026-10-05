import { logger } from "../../../utils/logger";
import { throwIfAborted } from "../../../utils/toolUtils";
import { accessibilityDetector } from "../../accessibility/AccessibilityDetector";
import type { AccessibilityDetector as AccessibilityDetectorContract } from "../../accessibility/interfaces/AccessibilityDetector";
import { iosVoiceOverDetector } from "../../accessibility/IosVoiceOverDetector";
import { FeatureFlagService } from "../../featureFlags/FeatureFlagService";
import { IOSCtrlProxyClient } from "../ios";
import type { BootedDevice, ObserveResult } from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";

export interface AccessibilityStateDetectorOptions {
  device: BootedDevice;
  adb: AdbExecutor;
  featureFlags?: FeatureFlagService;
  accessibilityDetector?: AccessibilityDetectorContract;
}

/**
 * Detects accessibility state (TalkBack on Android, VoiceOver on iOS) and
 * attaches it to the ObserveResult. Failures are logged but do not propagate.
 */
export class AccessibilityStateDetector {
  private readonly device: BootedDevice;
  private readonly adb: AdbExecutor;
  private readonly featureFlags: FeatureFlagService | undefined;
  private readonly detector: AccessibilityDetectorContract;

  constructor(opts: AccessibilityStateDetectorOptions) {
    this.device = opts.device;
    this.adb = opts.adb;
    this.featureFlags = opts.featureFlags;
    this.detector = opts.accessibilityDetector ?? accessibilityDetector;
  }

  async run(result: ObserveResult, perf: PerformanceTracker, signal?: AbortSignal): Promise<void> {
    try {
      await perf.track("accessibilityDetection", async () => {
        throwIfAborted(signal);

        // Get feature flag service instance
        const featureFlags = this.featureFlags ?? FeatureFlagService.getInstance();

        if (this.device.platform === "android") {
          // Detect TalkBack state via ADB
          const state = await this.detector.resolveState(
            this.device.deviceId,
            this.adb,
            featureFlags,
          );
          if (state === null) {
            // accessibilityState is optional: omit unavailable evidence rather than asserting off.
            delete result.accessibilityState;
            return;
          }
          const { enabled, service } = state;

          const detectionSkipped =
            !featureFlags.isEnabled("force-accessibility-mode") &&
            !featureFlags.isEnabled("accessibility-auto-detect");
          result.accessibilityState = { enabled, service, detectionSkipped };
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
