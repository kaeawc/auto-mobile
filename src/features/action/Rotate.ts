import { Mutex } from "async-mutex";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange } from "./BaseVisualChange";
import { BootedDevice, OrientationLockState, RotateResult } from "../../models";
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

  // Bounded settle-wait for the post-restore confirmation read (#6211). When
  // the device is physically held opposite the requested orientation,
  // WindowManager takes a moment to settle after `accelerometer_rotation` is
  // restored, so an immediate read can catch a transient value and report a
  // spurious "unconfirmed"/reverted result. The converse is just as real: a
  // FIRST sample that already matches the requested orientation is not proof
  // it is held — the physical sensor can swing it away moments later — so a
  // match is only accepted once it reads the same way on a second,
  // subsequent sample. Retry a few times, on the injected Timer, before
  // accepting the read as final (#6211 review).
  private static readonly SETTLE_WAIT_MAX_ATTEMPTS = 3;
  private static readonly SETTLE_WAIT_POLL_INTERVAL_MS = 150;
  private static readonly SETTLE_WAIT_STABLE_READS = 2;

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

  /**
   * Read the live rotation after restoring auto-rotate, with a bounded
   * settle-wait: WindowManager can take a moment to settle after
   * `accelerometer_rotation` is restored, particularly when the device is
   * physically held opposite the requested orientation, so an immediate read
   * can catch a transient value. Retry (on the injected Timer) until the
   * live read matches the requested orientation or the attempt budget is
   * exhausted, returning the last read either way so the caller can report
   * it honestly (#6211).
   */
  /**
   * Update an in-progress consecutive-match streak with a newly read
   * orientation. A `null` (unreadable) sample always breaks the streak
   * rather than extending or restarting it — it is a read failure, not a
   * confirming or contradicting orientation sample.
   */
  private updateOrientationStreak(
    achieved: "portrait" | "landscape" | null,
    streak: { achieved: "portrait" | "landscape" | null; count: number },
  ): void {
    if (achieved !== null && achieved === streak.achieved) {
      streak.count++;
    } else {
      streak.achieved = achieved;
      streak.count = achieved === null ? 0 : 1;
    }
  }

  /**
   * Decide the settle-wait's return value once the attempt budget is
   * exhausted without the requested orientation ever reaching the stability
   * threshold (#6211 review).
   */
  private resolveExhaustedSettleWait(
    lastAchieved: "portrait" | "landscape" | null,
    lastStreakCount: number,
    lastConfirmed: { value: number | null; achieved: "portrait" | "landscape" | null },
  ): number | null {
    // A lone final sample, whether it matches the requested orientation or
    // contradicts it, has no opportunity for a confirming later sample. Do
    // not turn that unsettled observation into either a definitive success or
    // a definitive reversion. A later non-null sample supersedes an earlier
    // confirmed streak unless that later sample completes its own confirmed
    // streak. An unreadable final sample leaves the earlier confirmed streak
    // as the newest trustworthy evidence.
    if (lastAchieved !== null) {
      return lastStreakCount >= Rotate.SETTLE_WAIT_STABLE_READS ? lastConfirmed.value : null;
    }
    return lastConfirmed.achieved !== null ? lastConfirmed.value : null;
  }

  private async readLiveRotationWithSettleWait(
    requestedOrientation: "portrait" | "landscape",
  ): Promise<number | null> {
    let lastValue: number | null = null;
    let lastAchieved: "portrait" | "landscape" | null = null;
    // Tracks consecutive matching samples for whichever orientation was last
    // read — not only the requested one — so a confirmed opposite-orientation
    // reversion (e.g. two consecutive landscape samples when portrait was
    // requested) is remembered in `lastConfirmed` even though it never
    // triggers the early-return below (#6211 review).
    const streak: { achieved: "portrait" | "landscape" | null; count: number } = {
      achieved: null,
      count: 0,
    };
    const lastConfirmed: { value: number | null; achieved: "portrait" | "landscape" | null } = {
      value: null,
      achieved: null,
    };
    for (let attempt = 1; attempt <= Rotate.SETTLE_WAIT_MAX_ATTEMPTS; attempt++) {
      lastValue = await this.readLiveRotation();
      lastAchieved =
        lastValue === null ? null : lastValue === 0 || lastValue === 2 ? "portrait" : "landscape";
      this.updateOrientationStreak(lastAchieved, streak);
      if (lastAchieved !== null && streak.count >= Rotate.SETTLE_WAIT_STABLE_READS) {
        lastConfirmed.value = lastValue;
        lastConfirmed.achieved = lastAchieved;
        // A single matching sample is not proof the orientation is held —
        // require it to hold across a second, later sample before accepting
        // it, rather than returning on the very first read (#6211 review).
        if (lastAchieved === requestedOrientation) {
          return lastValue;
        }
      }
      if (attempt < Rotate.SETTLE_WAIT_MAX_ATTEMPTS) {
        await this.timer.sleep(Rotate.SETTLE_WAIT_POLL_INTERVAL_MS);
      }
    }
    return this.resolveExhaustedSettleWait(lastAchieved, streak.count, lastConfirmed);
  }

  /**
   * Compose the post-restore confirmation warning. The wording must stay
   * state-neutral (never assert "auto-rotate is enabled") whenever the
   * restore write itself did not confirm success — otherwise the composed
   * warning contradicts the ambiguity note appended by the caller when
   * `restoreWriteError` is set (#6211 review).
   */
  private buildConfirmationWarning(
    requestedOrientation: "portrait" | "landscape",
    restoreConfirmed: boolean,
    achievedOrientation: "portrait" | "landscape" | null,
  ): string | undefined {
    if (achievedOrientation === requestedOrientation) {
      return undefined;
    }
    if (achievedOrientation === null) {
      return restoreConfirmed
        ? `Auto-rotate is enabled and the device's orientation after restoring it could not be confirmed (live rotation read failed); the requested ${requestedOrientation} orientation may not be held.`
        : `The device's orientation after attempting to restore auto-rotate could not be confirmed (live rotation read failed); the requested ${requestedOrientation} orientation may not be held.`;
    }
    return restoreConfirmed
      ? `Auto-rotate is enabled and immediately reverted the device to ${achievedOrientation} based on the physical sensor; the requested ${requestedOrientation} orientation is not held.`
      : `The device reverted to ${achievedOrientation} after attempting to restore auto-rotate; the requested ${requestedOrientation} orientation is not held.`;
  }

  /**
   * After restoring auto-rotate, determine what orientation the device
   * actually ended up in. Restoring auto-rotate can let the physical sensor
   * immediately re-apply its own orientation, overriding the one just
   * forced, so this confirmation read MUST be LIVE (mRotation from dumpsys
   * window) — falling back to `user_rotation` here would just echo the
   * value this same call wrote a moment ago and silently recreate the false
   * "requested orientation held" success this fix exists to prevent. The
   * read goes through a bounded settle-wait (#6211) so a momentarily
   * unsettled WindowManager doesn't yield a spurious "unconfirmed"/reverted
   * result. If the live read is still unavailable after settling, the
   * achieved orientation is reported as unconfirmed rather than guessed
   * (#6199 review). `restoreConfirmed` controls whether the composed warning
   * may assert "auto-rotate is enabled" (#6211 review).
   */
  private async confirmOrientationAfterAutoRotateRestore(
    requestedOrientation: "portrait" | "landscape",
    restoreConfirmed: boolean,
  ): Promise<{ achievedOrientation: string; warning: string | undefined }> {
    const liveRotationValue = await this.readLiveRotationWithSettleWait(requestedOrientation);
    if (liveRotationValue === null) {
      return {
        achievedOrientation: "unknown",
        warning: this.buildConfirmationWarning(requestedOrientation, restoreConfirmed, null),
      };
    }

    const achievedOrientation =
      liveRotationValue === 0 || liveRotationValue === 2 ? "portrait" : "landscape";
    return {
      achievedOrientation,
      warning: this.buildConfirmationWarning(
        requestedOrientation,
        restoreConfirmed,
        achievedOrientation,
      ),
    };
  }

  /**
   * Restore auto-rotate (previously forced off to apply an explicit
   * rotation) and determine the actual achieved orientation. A REJECTED
   * restore write does NOT prove auto-rotate stayed disabled: the underlying
   * put can time out AFTER CtrlProxy already applied it but before
   * broadcasting the result, so auto-rotate may in fact be back on and the
   * physical sensor may already have reverted the device. The live
   * orientation is therefore always re-confirmed afterward — the same way a
   * successful restore is confirmed — rather than assumed either way, and
   * the ambiguity (when present) is folded into the returned warning so the
   * caller can report the TRUE state (#6211 review).
   */
  private async restoreAutoRotateAndConfirmOrientation(
    requestedOrientation: "portrait" | "landscape",
  ): Promise<{
    achievedOrientation: string;
    warning: string | undefined;
    restoreConfirmed: boolean;
  }> {
    let restoreWriteError: unknown;
    try {
      await this.writeSystemSetting("accelerometer_rotation", "1");
    } catch (firstError) {
      // A single transient failure (e.g. a momentary CtrlProxy/ADB hiccup)
      // must not be treated as ambiguous on its own — retry once, the same
      // idempotent write, before falling back to the ambiguous-outcome path
      // (#6211 review).
      logger.debug(
        `[Rotate] accelerometer_rotation restore write failed on first attempt, retrying once: ${firstError}`,
      );
      try {
        await this.writeSystemSetting("accelerometer_rotation", "1");
      } catch (retryError) {
        restoreWriteError = retryError;
        logger.warn(
          `[Rotate] accelerometer_rotation restore write failed after retry (ambiguous outcome) after confirming rotation to ${requestedOrientation}: ${retryError}`,
        );
      }
    }

    const restoreConfirmed = restoreWriteError === undefined;
    const { achievedOrientation, warning: confirmWarning } =
      await this.confirmOrientationAfterAutoRotateRestore(requestedOrientation, restoreConfirmed);
    if (restoreConfirmed) {
      return { achievedOrientation, warning: confirmWarning, restoreConfirmed };
    }

    const ambiguityNote = `the accelerometer_rotation restore write failed after a retry (ambiguous outcome — could not confirm whether auto-rotate was actually re-enabled): ${restoreWriteError}`;
    const warning = confirmWarning
      ? `${confirmWarning} Additionally, ${ambiguityNote}`
      : `Rotated to ${requestedOrientation}, but ${ambiguityNote}`;
    return { achievedOrientation, warning, restoreConfirmed };
  }

  /**
   * Describe the rotation outcome without treating an unconfirmed restore as
   * proof that auto-rotate caused the final orientation. The orientation read
   * itself remains evidence and is retained in the message.
   */
  private buildRotationMessage(
    requestedOrientation: "portrait" | "landscape",
    previousOrientation: string,
    achievedOrientation: string,
    warning: string | undefined,
    restoreConfirmed: boolean,
  ): string {
    if (!warning) {
      return `Successfully rotated from ${previousOrientation} to ${requestedOrientation}`;
    }
    if (!restoreConfirmed) {
      if (achievedOrientation === "unknown") {
        return `Rotated to ${requestedOrientation}, but after attempting to restore auto-rotate, the device's current orientation could not be confirmed`;
      }
      if (achievedOrientation === requestedOrientation) {
        return `Rotated to ${requestedOrientation}; after attempting to restore auto-rotate, the device was confirmed to remain ${achievedOrientation}`;
      }
      return `Rotated to ${requestedOrientation}; after attempting to restore auto-rotate, the device was confirmed ${achievedOrientation}`;
    }
    if (achievedOrientation === "unknown") {
      return `Rotated to ${requestedOrientation}, but the device's orientation after auto-rotate restore could not be confirmed`;
    }
    if (achievedOrientation !== requestedOrientation) {
      return `Rotated to ${requestedOrientation}, but auto-rotate reverted the device to ${achievedOrientation}`;
    }
    return `Successfully rotated from ${previousOrientation} to ${requestedOrientation}`;
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

  private async getOrientationLockState(): Promise<OrientationLockState> {
    const autoRotateState = await this.getAutoRotateState();
    if (autoRotateState === "unknown") {
      return "unknown";
    }
    return autoRotateState === "locked" ? "locked" : "unlocked";
  }

  private async handleAlreadyAppliedOrientation(
    orientation: "portrait" | "landscape",
    value: number,
    currentOrientation: string,
    autoRotateState: "locked" | "enabled" | "unknown",
    preserveLock: boolean,
    restoreAutomaticRotation: boolean,
  ): Promise<RotateResult | null> {
    if (currentOrientation !== orientation) {
      return null;
    }

    const initialOrientationLockState: OrientationLockState =
      autoRotateState === "locked"
        ? "locked"
        : autoRotateState === "enabled"
          ? "unlocked"
          : "unknown";
    if (
      (preserveLock && initialOrientationLockState === "locked") ||
      (restoreAutomaticRotation && initialOrientationLockState === "unlocked") ||
      (!preserveLock && !restoreAutomaticRotation)
    ) {
      return {
        success: true,
        orientation,
        value,
        currentOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: false,
        orientationLockHandled: false,
        orientationLockState: initialOrientationLockState,
        message: `Device is already in ${orientation} orientation`,
      };
    }

    if (!restoreAutomaticRotation) {
      return null;
    }

    const { achievedOrientation, warning } =
      await this.restoreAutoRotateAndConfirmOrientation(orientation);
    const orientationLockState = await this.getOrientationLockState();
    if (orientationLockState !== "unlocked") {
      return {
        success: false,
        orientation,
        value,
        currentOrientation: achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: false,
        orientationLockHandled: true,
        orientationLockState,
        error: `Automatic rotation could not be confirmed as restored (orientation lock is ${orientationLockState}).`,
      };
    }
    return {
      success: true,
      orientation,
      value,
      currentOrientation: achievedOrientation,
      previousOrientation: currentOrientation,
      rotationPerformed: false,
      orientationLockHandled: true,
      orientationLockState,
      warning,
      message: `Restored automatic rotation; device is currently ${achievedOrientation}.`,
    };
  }

  private resolveAutoRotatePlan(
    autoRotateState: "locked" | "enabled" | "unknown",
    lockOrientation: boolean | undefined,
  ): {
    preserveLock: boolean;
    restoreAutomaticRotation: boolean;
    wasAutoRotateEnabled: boolean;
    shouldRestoreAutoRotate: boolean;
    canForceAutoRotateOff: boolean;
  } {
    const preserveLock = lockOrientation === true;
    const restoreAutomaticRotation = lockOrientation === false;
    const wasAutoRotateEnabled = autoRotateState === "enabled";
    return {
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
      shouldRestoreAutoRotate: restoreAutomaticRotation || (wasAutoRotateEnabled && !preserveLock),
      // The default preserves the #6199 guard against mutating an
      // unconfirmed setting. Explicit requests deliberately own the
      // resulting state, so they can force auto-rotate off first.
      canForceAutoRotateOff: lockOrientation !== undefined || autoRotateState !== "unknown",
    };
  }

  private logAutoRotatePlan(
    autoRotateState: "locked" | "enabled" | "unknown",
    preserveLock: boolean,
    restoreAutomaticRotation: boolean,
  ): void {
    if (preserveLock) {
      logger.info("Keeping the requested orientation locked after rotation");
    } else if (restoreAutomaticRotation) {
      logger.info("Rotating before explicitly restoring automatic rotation");
    } else if (autoRotateState === "locked") {
      logger.info("Orientation is locked; forcing the requested rotation");
    } else if (autoRotateState === "enabled") {
      logger.info("Auto-rotate is on; temporarily disabling it to force rotation");
    } else {
      logger.info(
        "accelerometer_rotation is unreadable; setting user_rotation only, without forcing accelerometer_rotation (no confirmed prior state to restore)",
      );
    }
  }

  private async finalizeAndroidRotation(
    orientation: "portrait" | "landscape",
    value: number,
    currentOrientation: string,
    achievedOrientation: string,
    warning: string | undefined,
    restoreConfirmed: boolean,
    preserveLock: boolean,
    restoreAutomaticRotation: boolean,
    wasAutoRotateEnabled: boolean,
  ): Promise<RotateResult> {
    const orientationLockState = await this.getOrientationLockState();
    const rotationPerformed = currentOrientation !== orientation;
    if (preserveLock && orientationLockState !== "locked") {
      return {
        success: false,
        orientation,
        value,
        currentOrientation: orientation,
        previousOrientation: currentOrientation,
        rotationPerformed,
        orientationLockHandled: false,
        orientationLockState,
        error: `${rotationPerformed ? `Rotated to ${orientation}` : `Device is already in ${orientation} orientation`}, but the persistent orientation lock could not be confirmed (auto-rotate is ${orientationLockState}).`,
      };
    }
    if (restoreAutomaticRotation && orientationLockState !== "unlocked") {
      return {
        success: false,
        orientation,
        value,
        currentOrientation: achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed,
        orientationLockHandled: true,
        orientationLockState,
        error: `Rotated to ${orientation}, but automatic rotation could not be confirmed as restored (orientation lock is ${orientationLockState}).`,
      };
    }
    return {
      success: true,
      orientation,
      value,
      currentOrientation: achievedOrientation,
      previousOrientation: currentOrientation,
      rotationPerformed,
      orientationLockHandled: wasAutoRotateEnabled,
      orientationLockState,
      warning,
      message: rotationPerformed
        ? this.buildRotationMessage(
            orientation,
            currentOrientation,
            achievedOrientation,
            warning,
            restoreConfirmed,
          )
        : `Locked device orientation to ${orientation}.`,
    };
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
    lockOrientation?: boolean,
  ): Promise<RotateResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("rotate");

    switch (this.device.platform) {
      case "ios":
        return this.executeIosRotation(orientation, progress, perf);
      case "android":
        return this.executeAndroidRotation(orientation, progress, perf, lockOrientation);
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
    lockOrientation: boolean | undefined,
  ): Promise<RotateResult> {
    return this.observedInteraction(
      // The read-auto-rotate -> disable -> rotate -> restore-auto-rotate
      // sequence below must run atomically per device: interleaving it with
      // a concurrent rotation on the same device would let one call observe
      // the other's temporary accelerometer_rotation=0 as the "prior state"
      // (#6199 review). Different devices use independent locks and never
      // wait on each other.
      () =>
        this.getRotationLock().runExclusive(() =>
          this.performAndroidRotation(orientation, perf, lockOrientation),
        ),
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
    lockOrientation: boolean | undefined,
  ): Promise<RotateResult> {
    const value = orientation === "portrait" ? 0 : 1;

    // Run getCurrentOrientation and getAutoRotateState in parallel
    const [currentOrientation, autoRotateState] = await perf.track("getOrientationState", () =>
      Promise.all([this.getCurrentOrientation(), this.getAutoRotateState()]),
    );

    const {
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
      shouldRestoreAutoRotate,
      canForceAutoRotateOff,
    } = this.resolveAutoRotatePlan(autoRotateState, lockOrientation);
    const alreadyApplied = await this.handleAlreadyAppliedOrientation(
      orientation,
      value,
      currentOrientation,
      autoRotateState,
      preserveLock,
      restoreAutomaticRotation,
    );
    if (alreadyApplied) {
      return alreadyApplied;
    }

    // Auto-rotate must be off for `user_rotation` writes to take effect,
    // regardless of whether it was already off beforehand. Remember the
    // pre-existing value so it can be restored once the forced rotation
    // completes, instead of leaving auto-rotate permanently disabled
    // (#6129). An explicit persistent request takes ownership of this state,
    // while explicit false restores automatic rotation even after a previous
    // persistent request.

    try {
      this.logAutoRotatePlan(autoRotateState, preserveLock, restoreAutomaticRotation);

      await perf.track("setRotation", async () => {
        if (canForceAutoRotateOff) {
          // user_rotation is honored only after automatic rotation is disabled.
          // Keeping these writes ordered avoids a target write racing ahead of
          // the lock on devices where the settings provider completes slowly.
          await this.writeSystemSetting("accelerometer_rotation", "0");
        } else {
          logger.debug(
            "[Rotate] accelerometer_rotation is unconfirmed; writing user_rotation without changing the lock state",
          );
        }
        await this.writeSystemSetting("user_rotation", String(value));
      });

      // Wait for rotation to complete (also serves as verification)
      await perf.track("waitForRotation", () => this.awaitIdle.waitForRotation(value));

      // Note: We skip explicit verification since waitForRotation already confirms
      // the rotation completed successfully by polling dumpsys window

      // waitForRotation(value) above already confirmed the device reached the
      // requested orientation while auto-rotate was forced off. The local
      // `currentOrientation` remains the legitimate prior value (see #6057).
      let achievedOrientation: string = orientation;
      let warning: string | undefined;
      let restoreConfirmed = true;

      if (shouldRestoreAutoRotate) {
        ({ achievedOrientation, warning, restoreConfirmed } =
          await this.restoreAutoRotateAndConfirmOrientation(orientation));
      }

      return this.finalizeAndroidRotation(
        orientation,
        value,
        currentOrientation,
        achievedOrientation,
        warning,
        restoreConfirmed,
        preserveLock,
        restoreAutomaticRotation,
        wasAutoRotateEnabled,
      );
    } catch (error) {
      // Restore auto-rotate on a failed temporary/explicit-unlock operation.
      // A persistent request intentionally leaves its lock in place.
      if (shouldRestoreAutoRotate) {
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
        orientationLockState: await this.getOrientationLockState(),
        error: `Failed to change device orientation: ${error}`,
      };
    }
  }
}
