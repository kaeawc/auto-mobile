import { Mutex } from "async-mutex";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange } from "./BaseVisualChange";
import { BootedDevice, RotateResult } from "../../models";
import { logger } from "../../utils/logger";
import { ProgressCallback } from "./BaseVisualChange";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";
import { parseWindowManagerRotation } from "../../utils/android-cmdline-tools/parseWindowManagerRotation";

export class Rotate extends BaseVisualChange {
  // Serializes the read-auto-rotate -> disable -> rotate -> restore-auto-rotate
  // critical section per device, so two concurrent rotations against the SAME
  // device cannot interleave: without this, one rotation could read the
  // other's temporary `accelerometer_rotation=0` as the "prior state" and
  // later restore auto-rotate to the wrong value (#6199 review). Keyed by
  // deviceId (not per-instance) since a new Rotate is constructed per tool
  // call. Deliberately NOT shared across different devices.
  private static readonly rotationLocks = new Map<string, Mutex>();

  constructor(device: BootedDevice, adb: AdbClient | null = null, timer: Timer = defaultTimer) {
    super(device, adb, timer);
  }

  private getRotationLock(): Mutex {
    let lock = Rotate.rotationLocks.get(this.device.deviceId);
    if (!lock) {
      lock = new Mutex();
      Rotate.rotationLocks.set(this.device.deviceId, lock);
    }
    return lock;
  }

  /**
   * Get the current device orientation
   * @returns Promise with current orientation ("portrait" or "landscape")
   */
  private async readSystemSetting(key: string): Promise<string | null> {
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const a11yResult = await a11y.requestSettingsGet("system", key);
      if (a11yResult.success) {
        return a11yResult.found ? (a11yResult.value ?? null) : null;
      }
    } catch (error) {
      logger.debug(`[Rotate] a11y settings get failed for ${key}: ${error}`);
    }
    try {
      const result = await this.adb.executeCommand(`shell settings get system ${key}`);
      const out = result.stdout.trim();
      return !out || out === "null" ? null : out;
    } catch (error) {
      logger.warn(`Failed to read system setting ${key}: ${error}`);
      return null;
    }
  }

  /**
   * Read the live device rotation from the window manager (`dumpsys window`).
   * Unlike the `user_rotation` setting, this reflects the rotation actually
   * applied by the sensor when auto-rotate is on, so it cannot go stale the
   * way `user_rotation` does (issue #6129). Parsing is delegated to
   * {@link parseWindowManagerRotation}, which selects the authoritative
   * display rotation and skips stale/unrelated `mRotation=` occurrences
   * (e.g. a cached TaskSnapshot) elsewhere in the dump (issue #6199).
   * @returns The parsed rotation value, or null if it could not be read
   */
  private async readLiveRotation(): Promise<number | null> {
    try {
      const { stdout } = await this.adb.executeCommand(
        'shell dumpsys window | grep -i "mRotation="',
      );
      return parseWindowManagerRotation(stdout);
    } catch (error) {
      logger.debug(`[Rotate] Failed to read live rotation via dumpsys window: ${error}`);
      return null;
    }
  }

  async getCurrentOrientation(): Promise<string> {
    // Prefer the live window-manager rotation: `user_rotation` only reflects
    // the last explicitly-requested rotation and goes stale as soon as
    // auto-rotate applies a sensor-driven rotation on top of it (#6129).
    const liveRotation = await this.readLiveRotation();
    if (liveRotation !== null) {
      // 0 = portrait, 1 = landscape (90°), 2 = reverse portrait (180°), 3 = reverse landscape (270°)
      return liveRotation === 0 || liveRotation === 2 ? "portrait" : "landscape";
    }

    const userRotationStr = await this.readSystemSetting("user_rotation");

    if (!userRotationStr || !/^\d+$/.test(userRotationStr)) {
      logger.warn(`Invalid user_rotation value: ${userRotationStr}, defaulting to portrait`);
      return "portrait";
    }

    const userRotation = parseInt(userRotationStr, 10);

    // Convert numeric value to orientation string
    // 0 = portrait, 1 = landscape (90°), 2 = reverse portrait (180°), 3 = reverse landscape (270°)
    // For simplicity, we'll treat 0,2 as portrait and 1,3 as landscape
    return userRotation === 0 || userRotation === 2 ? "portrait" : "landscape";
  }

  /**
   * Read the `accelerometer_rotation` setting as a tri-state: "locked" and
   * "enabled" are CONFIRMED readings, "unknown" means the setting was absent,
   * unreadable, or malformed. Callers must not treat "unknown" as either
   * confirmed state — in particular, auto-rotate must only be restored after
   * a rotation when it was CONFIRMED enabled beforehand (#6199 review).
   * @returns "locked" (auto-rotation disabled), "enabled" (auto-rotation on),
   *   or "unknown" when the setting could not be confirmed
   */
  private async getAutoRotateState(): Promise<"locked" | "enabled" | "unknown"> {
    const val = await this.readSystemSetting("accelerometer_rotation");
    if (val === null || !/^\d+$/.test(val)) {
      return "unknown";
    }
    // 0 = locked (auto-rotation disabled), 1 = unlocked (auto-rotation enabled)
    return parseInt(val, 10) === 0 ? "locked" : "enabled";
  }

  /**
   * Check if orientation is locked
   * @returns Promise with boolean indicating if auto-rotation is disabled
   */
  async isOrientationLocked(): Promise<boolean> {
    return (await this.getAutoRotateState()) === "locked";
  }

  private async writeSystemSetting(key: string, value: string): Promise<void> {
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.device);
      const a11yResult = await a11y.requestSettingsPut("system", key, value, "int");
      if (a11yResult.success) {
        return;
      }
      logger.debug(`[Rotate] a11y settings put failed for ${key}: ${a11yResult.error}`);
    } catch (error) {
      logger.debug(`[Rotate] a11y settings put threw for ${key}: ${error}`);
    }
    await this.adb.executeCommand(`shell settings put system ${key} ${value}`);
  }

  async execute(
    orientation: "portrait" | "landscape",
    progress?: ProgressCallback,
  ): Promise<RotateResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("rotate");

    switch (this.device.platform) {
      case "ios":
        return this.executeIosRotation(orientation, progress, perf);
      case "android":
        return this.executeAndroidRotation(orientation, progress, perf);
      default:
        throw new Error(`Unsupported platform: ${this.device.platform}`);
    }
  }

  private async executeIosRotation(
    orientation: "portrait" | "landscape",
    progress: ProgressCallback | undefined,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<RotateResult> {
    return this.observedInteraction(
      async () => {
        try {
          const client = IOSCtrlProxyClient.getInstance(this.device);
          const result = await perf.track("iOSRotation", () =>
            client.requestRotate(orientation, 5000, perf),
          );

          if (!result.success) {
            return {
              success: false,
              orientation,
              value: orientation === "portrait" ? 0 : 1,
              error: result.error ?? "Failed to rotate iOS device",
            };
          }

          return {
            success: true,
            orientation,
            value: result.value,
            currentOrientation: result.currentOrientation,
            previousOrientation: result.previousOrientation,
            rotationPerformed: result.rotationPerformed,
            orientationLockHandled: false,
            message: result.rotationPerformed
              ? `Successfully rotated from ${result.previousOrientation} to ${result.currentOrientation}`
              : `Device is already in ${orientation} orientation`,
          };
        } catch (error) {
          throw new Error(`Failed to rotate iOS device: ${error}`);
        }
      },
      {
        changeExpected: true,
        timeoutMs: 5000,
        progress,
        perf,
        skipUiStability: true,
      },
    );
  }

  private async executeAndroidRotation(
    orientation: "portrait" | "landscape",
    progress: ProgressCallback | undefined,
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<RotateResult> {
    return this.observedInteraction(
      // The read-auto-rotate -> disable -> rotate -> restore-auto-rotate
      // sequence below must run atomically per device: interleaving it with
      // a concurrent rotation on the same device would let one call observe
      // the other's temporary accelerometer_rotation=0 as the "prior state"
      // (#6199 review). Different devices use independent locks and never
      // wait on each other.
      () =>
        this.getRotationLock().runExclusive(() => this.performAndroidRotation(orientation, perf)),
      {
        changeExpected: true,
        timeoutMs: 5000,
        progress,
        perf,
        // Skip gfxinfo-based UI stability tracking for rotation - it incorrectly
        // detects rotation animation as "unstable UI" and can cause 5+ second waits
        skipUiStability: true,
      },
    );
  }

  /**
   * The read-auto-rotate -> disable -> rotate -> restore-auto-rotate critical
   * section for Android rotation. Callers MUST run this under
   * {@link getRotationLock} to serialize it per device (#6199 review).
   */
  private async performAndroidRotation(
    orientation: "portrait" | "landscape",
    perf: ReturnType<typeof createGlobalPerformanceTracker>,
  ): Promise<RotateResult> {
    const value = orientation === "portrait" ? 0 : 1;

    // Run getCurrentOrientation and getAutoRotateState in parallel
    const [currentOrientation, autoRotateState] = await perf.track("getOrientationState", () =>
      Promise.all([this.getCurrentOrientation(), this.getAutoRotateState()]),
    );

    // Check if device is already in the desired orientation
    if (currentOrientation === orientation) {
      return {
        success: true,
        orientation,
        value,
        currentOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: false,
        orientationLockHandled: false,
        message: `Device is already in ${orientation} orientation`,
      };
    }

    // Auto-rotate must be off for `user_rotation` writes to take effect,
    // regardless of whether it was already off beforehand. Remember the
    // pre-existing value so it can be restored once the forced rotation
    // completes, instead of leaving auto-rotate permanently disabled
    // (#6129). Only restore when we CONFIRMED auto-rotate was on beforehand
    // — an unreadable/malformed reading must never be fabricated into a
    // state to restore (#6199 review).
    const wasAutoRotateEnabled = autoRotateState === "enabled";

    try {
      if (autoRotateState === "locked") {
        logger.info("Orientation is locked; forcing the requested rotation");
      } else if (autoRotateState === "enabled") {
        logger.info("Auto-rotate is on; temporarily disabling it to force rotation");
      } else {
        logger.info(
          "accelerometer_rotation is unreadable; forcing rotation without restoring it afterward",
        );
      }

      await perf.track("setRotation", () =>
        Promise.all([
          this.writeSystemSetting("accelerometer_rotation", "0"),
          this.writeSystemSetting("user_rotation", String(value)),
        ]),
      );

      // Wait for rotation to complete (also serves as verification)
      await perf.track("waitForRotation", () => this.awaitIdle.waitForRotation(value));

      // Note: We skip explicit verification since waitForRotation already confirms
      // the rotation completed successfully by polling dumpsys window

      // waitForRotation(value) above already confirmed the device reached the
      // requested orientation while auto-rotate was forced off. The local
      // `currentOrientation` remains the legitimate prior value (see #6057).
      let achievedOrientation: string = orientation;
      let warning: string | undefined;

      if (wasAutoRotateEnabled) {
        await this.writeSystemSetting("accelerometer_rotation", "1");

        // Restoring auto-rotate can let the physical sensor immediately
        // re-apply its own orientation, overriding the one we just forced.
        // Re-read the live orientation so we report what actually ended up
        // held, rather than blindly claiming the requested orientation
        // stuck (#6199 review).
        achievedOrientation = await this.getCurrentOrientation();
        if (achievedOrientation !== orientation) {
          warning = `Auto-rotate is enabled and immediately reverted the device to ${achievedOrientation} based on the physical sensor; the requested ${orientation} orientation is not held.`;
        }
      }

      return {
        success: true,
        orientation,
        value,
        currentOrientation: achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: true,
        orientationLockHandled: wasAutoRotateEnabled,
        warning,
        message: warning
          ? `Rotated to ${orientation}, but auto-rotate reverted the device to ${achievedOrientation}`
          : `Successfully rotated from ${currentOrientation} to ${orientation}`,
      };
    } catch (error) {
      // Restore auto-rotate if it was on before this call
      if (wasAutoRotateEnabled) {
        try {
          await this.writeSystemSetting("accelerometer_rotation", "1");
          logger.info("Restored auto-rotate after error");
        } catch (restoreError) {
          logger.warn(`Failed to restore auto-rotate: ${restoreError}`);
        }
      }

      return {
        success: false,
        orientation,
        value,
        currentOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: false,
        orientationLockHandled: wasAutoRotateEnabled,
        error: `Failed to change device orientation: ${error}`,
      };
    }
  }
}
