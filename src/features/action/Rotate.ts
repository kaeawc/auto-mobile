import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange } from "./BaseVisualChange";
import { BootedDevice, RotateResult } from "../../models";
import { logger } from "../../utils/logger";
import { ProgressCallback } from "./BaseVisualChange";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { IOSCtrlProxyClient } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android/AndroidCtrlProxyClient";

export class Rotate extends BaseVisualChange {
  constructor(device: BootedDevice, adb: AdbClient | null = null, timer: Timer = defaultTimer) {
    super(device, adb, timer);
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

  async getCurrentOrientation(): Promise<string> {
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
   * Check if orientation is locked
   * @returns Promise with boolean indicating if auto-rotation is disabled
   */
  async isOrientationLocked(): Promise<boolean> {
    const val = await this.readSystemSetting("accelerometer_rotation");
    if (val === null) {
      return false;
    }
    const autoRotate = parseInt(val, 10);
    // 0 = locked (auto-rotation disabled), 1 = unlocked (auto-rotation enabled)
    return autoRotate === 0;
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
      async () => {
        const value = orientation === "portrait" ? 0 : 1;

        // Run getCurrentOrientation and isOrientationLocked in parallel
        const [currentOrientation, isLocked] = await perf.track("getOrientationState", () =>
          Promise.all([this.getCurrentOrientation(), this.isOrientationLocked()]),
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

        let orientationUnlocked = false;

        try {
          // If orientation is locked, unlock it temporarily
          if (isLocked) {
            logger.info("Orientation is locked, temporarily unlocking for rotation");
            await this.writeSystemSetting("accelerometer_rotation", "1");
            orientationUnlocked = true;
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

          return {
            success: true,
            orientation,
            value,
            // waitForRotation(value) above already confirmed the device reached the
            // requested orientation, so report the achieved orientation here. The local
            // `currentOrientation` remains the legitimate prior value (see #6057).
            currentOrientation: orientation,
            previousOrientation: currentOrientation,
            rotationPerformed: true,
            orientationLockHandled: orientationUnlocked,
            message: `Successfully rotated from ${currentOrientation} to ${orientation}`,
          };
        } catch (error) {
          // Restore orientation lock if we unlocked it
          if (orientationUnlocked) {
            try {
              await this.writeSystemSetting("accelerometer_rotation", "0");
              logger.info("Restored orientation lock after error");
            } catch (restoreError) {
              logger.warn(`Failed to restore orientation lock: ${restoreError}`);
            }
          }

          return {
            success: false,
            orientation,
            value,
            currentOrientation,
            previousOrientation: currentOrientation,
            rotationPerformed: false,
            orientationLockHandled: orientationUnlocked,
            error: `Failed to change device orientation: ${error}`,
          };
        }
      },
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
}
