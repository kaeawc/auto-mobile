import type { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import type { VoiceOverResult } from "../../models/AccessibilityResult";
import type { IosVoiceOverDetector } from "../../utils/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector } from "../../utils/IosVoiceOverDetector";
import type { ProcessExecutor } from "../../utils/ProcessExecutor";
import { DefaultProcessExecutor } from "../../utils/ProcessExecutor";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { IOSCtrlProxyClient } from "../observe/ios";

export class VoiceOverToggle {
  constructor(
    private readonly device: BootedDevice,
    private readonly detector: IosVoiceOverDetector = iosVoiceOverDetector,
    private readonly processExecutor: ProcessExecutor = new DefaultProcessExecutor()
  ) {}

  async toggle(enabled: boolean): Promise<VoiceOverResult> {
    if (!this.isSimulator()) {
      return {
        supported: false,
        applied: false,
        reason: "VoiceOver toggle is only supported on iOS Simulator"
      };
    }

    // Always run the simctl commands — they are idempotent and skipping them
    // based on a detection result is unsafe: IosVoiceOverDetector maps
    // detection failures to false, so a CtrlProxy outage would cause
    // toggle(false) to silently no-op when VoiceOver is actually on.
    //
    // A simctl failure is wrapped into a typed result rather than propagating
    // raw out of toggle(), matching TalkBackToggle's graceful contract (#3921).
    const boolValue = enabled ? "YES" : "NO";
    try {
      await this.processExecutor.exec(
        `xcrun simctl spawn ${this.device.deviceId} defaults write com.apple.Accessibility VoiceOverTouchEnabled -bool ${boolValue}`
      );
      await this.processExecutor.exec(
        `xcrun simctl spawn ${this.device.deviceId} notifyutil -p com.apple.accessibility.VoiceOverStatusDidChange`
      );
      const serviceCommand = enabled
        ? "launchctl kickstart -p system/com.apple.VoiceOverTouch"
        : "launchctl kill SIGTERM system/com.apple.VoiceOverTouch";
      try {
        await this.processExecutor.exec(
          `xcrun simctl spawn ${this.device.deviceId} ${serviceCommand}`
        );
      } catch (error) {
        if (enabled || !this.isServiceAlreadyStopped(error)) {
          throw error;
        }
        logger.debug("[VoiceOverToggle] VoiceOver service was already stopped");
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(`[VoiceOverToggle] Failed to ${enabled ? "enable" : "disable"} VoiceOver: ${reason}`);
      return {
        supported: true,
        applied: false,
        reason
      };
    }

    // Flush the detection cache and re-detect to CONFIRM the state actually
    // changed — never report success optimistically. If the simctl write + post
    // did not land, `applied` reflects the real post-apply state rather than the
    // requested one (#3921). Detection failure maps to `false`, so a confirmation
    // that cannot be read reports the toggle as not-applied (conservative).
    this.detector.invalidateCache(this.device.deviceId);
    // Resolve lazily so the iOS singleton is only touched on the iOS path.
    const client = IOSCtrlProxyClient.getInstance(this.device);
    const confirmedEnabled = await this.detector.isVoiceOverEnabled(this.device.deviceId, client);

    return {
      supported: true,
      applied: confirmedEnabled === enabled,
      currentState: confirmedEnabled
    };
  }

  private isSimulator(): boolean {
    return isIosSimulatorUdid(this.device.deviceId);
  }

  private isServiceAlreadyStopped(error: unknown): boolean {
    return error instanceof Error && error.message.includes("No process to signal.");
  }
}
