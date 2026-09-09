import { errorMessage } from "../../utils/describeUnknownError";
import type { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import type { VoiceOverResult } from "../../models/AccessibilityResult";
import type { IosVoiceOverDetector } from "../../utils/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector } from "../../utils/IosVoiceOverDetector";
import {
  DefaultHostCommandExecutor,
  type HostCommandExecutor,
} from "../../utils/HostCommandExecutor";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient, type IOSCtrlProxy } from "../observe/ios";

const VOICEOVER_CONFIRMATION_TIMEOUT_MS = 10_000;
const VOICEOVER_CONFIRMATION_POLL_INTERVAL_MS = 500;

export class VoiceOverToggle {
  constructor(
    private readonly device: BootedDevice,
    private readonly detector: IosVoiceOverDetector = iosVoiceOverDetector,
    private readonly processExecutor: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly timer: Timer = defaultTimer,
    // Resolve lazily so the iOS singleton is only touched when the toggle runs,
    // and so tests can inject a fake CtrlProxy for the physical-device path.
    private readonly clientProvider: () => IOSCtrlProxy = () =>
      IOSCtrlProxyClient.getInstance(this.device),
  ) {}

  async toggle(enabled: boolean): Promise<VoiceOverResult> {
    if (!this.isSimulator()) {
      return this.toggleViaSettings(enabled);
    }

    return this.toggleViaSimctl(enabled);
  }

  /**
   * Physical-device path: drive the Settings app through the CtrlProxy runner.
   *
   * There is no command-line write into a real device's system-preferences
   * domain (no `simctl`/`defaults`/`notifyutil` analog), so the runner opens
   * `App-Prefs:root=ACCESSIBILITY`, reads the VoiceOver switch, and taps only
   * when it differs — early-returning when already in the target state because
   * once VoiceOver is on every tap requires the double-tap idiom (#2501).
   *
   * We trust the runner's `success` (it confirms/early-returns on-device) rather
   * than re-detecting host-side: unlike the Simulator's fire-and-forget `simctl`
   * write, the Settings tap is synchronous on the device. A failure (e.g. the
   * locale-fragile Settings row could not be found) surfaces as
   * `supported:false` with the reason — never a silent success (#2501, inv. 5).
   */
  private async toggleViaSettings(enabled: boolean): Promise<VoiceOverResult> {
    const client = this.clientProvider();
    const result = await client.requestSetVoiceOverEnabled(enabled);
    if (!result.success) {
      const reason = result.error ?? "Failed to toggle VoiceOver via Settings";
      // Log before returning so the Settings-row-not-found case leaves a trace,
      // matching the Simulator path's logger.warn (the reason also surfaces to
      // the client as an ActionableError).
      logger.warn(
        `[VoiceOverToggle] Failed to ${enabled ? "enable" : "disable"} VoiceOver via Settings: ${reason}`,
      );
      return {
        supported: false,
        applied: false,
        reason,
      };
    }

    // Parity with the Simulator path: a successful toggle changes device state,
    // so the cached detection is now stale.
    this.detector.invalidateCache(this.device.deviceId);
    return {
      supported: true,
      applied: true,
      currentState: enabled,
    };
  }

  private async toggleViaSimctl(enabled: boolean): Promise<VoiceOverResult> {
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
        "simctl",
        "spawn",
        this.device.deviceId,
        "defaults",
        "write",
        "com.apple.Accessibility",
        "VoiceOverTouchEnabled",
        "-bool",
        boolValue,
      ]);
      await this.processExecutor.executeCommand("xcrun", [
        "simctl",
        "spawn",
        this.device.deviceId,
        "notifyutil",
        "-p",
        "com.apple.accessibility.VoiceOverStatusDidChange",
      ]);
      const serviceCommand = enabled
        ? "launchctl kickstart -p system/com.apple.VoiceOverTouch"
        : "launchctl kill SIGTERM system/com.apple.VoiceOverTouch";
      try {
        await this.processExecutor.executeCommand("xcrun", [
          "simctl",
          "spawn",
          this.device.deviceId,
          ...serviceCommand.split(" "),
        ]);
      } catch (error) {
        if (enabled || !this.isServiceAlreadyStopped(error)) {
          throw error;
        }
        logger.debug("[VoiceOverToggle] VoiceOver service was already stopped");
      }
    } catch (error) {
      const reason = errorMessage(error);
      logger.warn(
        `[VoiceOverToggle] Failed to ${enabled ? "enable" : "disable"} VoiceOver: ${reason}`,
      );
      return {
        supported: true,
        applied: false,
        reason,
      };
    }

    // Flush the detection cache and re-detect to CONFIRM the state actually
    // changed — never report success optimistically. If the simctl write + post
    // did not land, `applied` reflects the real post-apply state rather than the
    // requested one (#3921). An unreadable confirmation (CtrlProxy down,
    // timeout, or an unsuccessful probe) is reported as unconfirmed rather
    // than coalesced into `false` — a `toggle(false)` must not coincidentally
    // match an indeterminate probe and short-circuit the poll window (#6496).
    // Resolve lazily so the iOS singleton is only touched on the iOS path.
    const client = this.clientProvider();
    const confirmedState = await this.waitForState(enabled, client);

    if (confirmedState === null) {
      const reason = `VoiceOver state could not be confirmed within ${VOICEOVER_CONFIRMATION_TIMEOUT_MS}ms`;
      logger.warn(`[VoiceOverToggle] ${reason}`);
      return {
        supported: true,
        applied: false,
        reason,
      };
    }

    return {
      supported: true,
      applied: confirmedState === enabled,
      currentState: confirmedState,
    };
  }

  private isSimulator(): boolean {
    return isIosSimulatorUdid(this.device.deviceId);
  }

  /**
   * CtrlProxy can observe VoiceOver before its launchctl job has fully started.
   * Poll the post-apply confirmation through the injectable timer so a successful
   * enable is not reported as failed merely because its service is still starting.
   *
   * Uses the tri-state `resolveState` (not the boolean-coalescing
   * `isVoiceOverEnabled`) so an indeterminate probe (`null`) keeps polling
   * for the full window instead of coincidentally matching `enabled: false`
   * on the first, unreadable read (#6496). The last-observed tri-state is
   * returned as-is on deadline expiry — `null` means the confirmation was
   * never actually read, which the caller must report as unconfirmed rather
   * than a coincidental match.
   */
  private async waitForState(enabled: boolean, client: IOSCtrlProxy): Promise<boolean | null> {
    const deadline = this.timer.now() + VOICEOVER_CONFIRMATION_TIMEOUT_MS;
    let lastObservedState: boolean | null = null;

    while (true) {
      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        return lastObservedState;
      }

      this.detector.invalidateCache(this.device.deviceId);
      lastObservedState = await this.detector.resolveState(
        this.device.deviceId,
        client,
        undefined,
        remainingMs,
      );
      if (lastObservedState === enabled || this.timer.now() >= deadline) {
        return lastObservedState;
      }

      await this.timer.sleep(
        Math.min(VOICEOVER_CONFIRMATION_POLL_INTERVAL_MS, deadline - this.timer.now()),
      );
    }
  }

  private isServiceAlreadyStopped(error: unknown): boolean {
    return error instanceof Error && error.message.includes("No process to signal.");
  }
}
