import { errorMessage } from "../../utils/describeUnknownError";
import type { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import type { VoiceOverResult } from "../../models/AccessibilityResult";
import type { IosVoiceOverDetector } from "../../utils/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector } from "../../utils/IosVoiceOverDetector";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../../utils/HostCommandExecutor";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient } from "../observe/ios";

const VOICEOVER_CONFIRMATION_TIMEOUT_MS = 10_000;
const VOICEOVER_CONFIRMATION_POLL_INTERVAL_MS = 500;

export class VoiceOverToggle {
  constructor(
    private readonly device: BootedDevice,
    private readonly detector: IosVoiceOverDetector = iosVoiceOverDetector,
    private readonly processExecutor: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly timer: Timer = defaultTimer
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
      await this.processExecutor.executeCommand("xcrun", [
        "simctl", "spawn", this.device.deviceId, "defaults", "write", "com.apple.Accessibility", "VoiceOverTouchEnabled", "-bool", boolValue
      ]);
      await this.processExecutor.executeCommand("xcrun", [
        "simctl", "spawn", this.device.deviceId, "notifyutil", "-p", "com.apple.accessibility.VoiceOverStatusDidChange"
      ]);
      const serviceCommand = enabled
        ? "launchctl kickstart -p system/com.apple.VoiceOverTouch"
        : "launchctl kill SIGTERM system/com.apple.VoiceOverTouch";
      try {
        await this.processExecutor.executeCommand("xcrun", [
          "simctl", "spawn", this.device.deviceId, ...serviceCommand.split(" ")
        ]);
      } catch (error) {
        if (enabled || !this.isServiceAlreadyStopped(error)) {
          throw error;
        }
        logger.debug("[VoiceOverToggle] VoiceOver service was already stopped");
      }
    } catch (error) {
      const reason = errorMessage(error);
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
    // Resolve lazily so the iOS singleton is only touched on the iOS path.
    const client = IOSCtrlProxyClient.getInstance(this.device);
    const confirmedEnabled = await this.waitForState(enabled, client);

    return {
      supported: true,
      applied: confirmedEnabled === enabled,
      currentState: confirmedEnabled
    };
  }

  private isSimulator(): boolean {
    return isIosSimulatorUdid(this.device.deviceId);
  }

  /**
   * CtrlProxy can observe VoiceOver before its launchctl job has fully started.
   * Poll the post-apply confirmation through the injectable timer so a successful
   * enable is not reported as failed merely because its service is still starting.
   */
  private async waitForState(enabled: boolean, client: IOSCtrlProxyClient): Promise<boolean> {
    const deadline = this.timer.now() + VOICEOVER_CONFIRMATION_TIMEOUT_MS;
    let confirmedEnabled = false;

    while (true) {
      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        return confirmedEnabled;
      }

      this.detector.invalidateCache(this.device.deviceId);
      confirmedEnabled = await this.detector.isVoiceOverEnabled(
        this.device.deviceId,
        client,
        undefined,
        remainingMs
      );
      if (confirmedEnabled === enabled || this.timer.now() >= deadline) {
        return confirmedEnabled;
      }

      await this.timer.sleep(Math.min(VOICEOVER_CONFIRMATION_POLL_INTERVAL_MS, deadline - this.timer.now()));
    }
  }

  private isServiceAlreadyStopped(error: unknown): boolean {
    return error instanceof Error && error.message.includes("No process to signal.");
  }
}
