/**
 * RotationOutcomes - plans and reports the result of an Android rotation.
 *
 * Extracted from Rotate (max-class-lines): the auto-rotate plan, the already-in-orientation
 * shortcuts, auto-rotate restoration with orientation confirmation, and result/message building.
 */

import { throwIfAborted } from "../../utils/toolUtils";
import { ActionableError } from "../../models/ActionableError";
import { OrientationLockState, RotateResult } from "../../models";
import { logger } from "../../utils/logger";
import {
  POST_RESTORE_SETTLE_PROFILE,
  type RotationOrientationReader,
} from "./RotationOrientationReader";
import type { RotationSettingsStore } from "./RotationSettingsStore";
import type {
  RotationCallSettings,
  RotationContext,
  RotationSettingCleanup,
} from "./RotationSupport";

export type AutoRotatePlan = {
  preserveLock: boolean;
  restoreAutomaticRotation: boolean;
  wasAutoRotateEnabled: boolean;
  shouldRestoreAutoRotate: boolean;
  canForceAutoRotateOff: boolean;
  restoreAfterConfirmation: boolean;
};

type AlreadyAppliedOrientationDecision =
  | { kind: "handled"; result: RotateResult }
  | {
      kind: "requires-rotation";
      reason: "orientation-differs" | "live-rotation-unavailable" | "live-orientation-changed";
    };

export type { AlreadyAppliedOrientationDecision };

interface AndroidRotationResultOptions {
  orientation: "portrait" | "landscape";
  value: number;
  currentOrientation: string;
  achievedOrientation: string;
  warning: string | undefined;
  restoreConfirmed: boolean;
  preserveLock: boolean;
  restoreAutomaticRotation: boolean;
  wasAutoRotateEnabled: boolean;
  signal?: AbortSignal;
}

export class RotationOutcomes {
  constructor(
    private readonly ctx: () => RotationContext,
    private readonly reader: RotationOrientationReader,
    private readonly store: RotationSettingsStore,
  ) {}

  async lockAlreadyAppliedOrientation(
    orientation: "portrait" | "landscape",
    value: number,
    currentOrientation: string,
    {
      options,
      signal,
    }: {
      options: {
        beforeWrite: RotationCallSettings["beforeWrite"];
        cleanup: RotationSettingCleanup;
      };
      signal?: AbortSignal;
    },
  ): Promise<AlreadyAppliedOrientationDecision> {
    throwIfAborted(signal);
    const { beforeWrite, cleanup } = options;
    const liveRotation = await this.reader.readLiveRotation(signal);
    if (liveRotation === null) {
      // The normal rotation path can still establish the requested orientation
      // when the exact live rotation is temporarily unavailable.
      return { kind: "requires-rotation", reason: "live-rotation-unavailable" };
    }
    const liveOrientation = await this.reader.orientationOfRotation(liveRotation, signal);
    if (liveOrientation !== orientation) {
      // The display changed after the initial read; perform a normal requested
      // rotation instead of locking a now-opposite orientation.
      return { kind: "requires-rotation", reason: "live-orientation-changed" };
    }

    // Capture both originals before the first write; an unreadable session
    // baseline is a structured failure, never an unrestorable mutation.
    await beforeWrite({ accelerometerRotation: true, captureUserRotation: true });
    try {
      // Android applies user_rotation when auto-rotate is disabled. Persist
      // the exact live value before the lock so stale settings cannot rotate
      // an already-matching (including reverse) display.
      await beforeWrite({ userRotation: liveRotation });
      await this.store.writeSystemSetting("user_rotation", String(liveRotation), signal, cleanup);
      await beforeWrite();
      await this.store.writeSystemSetting("accelerometer_rotation", "0", signal, cleanup);
      await this.ctx().awaitIdle.waitForRotation(liveRotation, undefined, signal);
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Failed to lock the current ${orientation} orientation: ${error}`, error);
      return {
        kind: "handled",
        result: {
          success: false,
          orientation,
          value,
          currentOrientation,
          previousOrientation: currentOrientation,
          rotationPerformed: false,
          orientationLockHandled: false,
          orientationLockState: await this.reader.getOrientationLockState(signal),
          error: `Failed to lock the device in its current ${orientation} orientation: ${error}`,
        },
      };
    }

    const orientationLockState = await this.reader.getOrientationLockState(signal);
    const confirmedRotation = await this.reader.readLiveRotation(signal);
    if (orientationLockState !== "locked" || confirmedRotation !== liveRotation) {
      const achievedOrientation =
        confirmedRotation === null
          ? "unknown"
          : await this.reader.orientationOfRotation(confirmedRotation, signal);
      return {
        kind: "handled",
        result: {
          success: false,
          orientation,
          value,
          currentOrientation: achievedOrientation,
          previousOrientation: currentOrientation,
          rotationPerformed: false,
          orientationLockHandled: false,
          orientationLockState,
          error: `Device was already in ${orientation} orientation, but its exact locked rotation could not be confirmed (auto-rotate is ${orientationLockState}).`,
        },
      };
    }

    return {
      kind: "handled",
      result: {
        success: true,
        orientation,
        value,
        currentOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: false,
        orientationLockHandled: true,
        orientationLockState,
        message: `Locked device orientation to ${orientation}.`,
      },
    };
  }

  private shouldReturnAlreadyAppliedOrientation(
    preserveLock: boolean,
    restoreAutomaticRotation: boolean,
    initialOrientationLockState: OrientationLockState,
  ): boolean {
    return (
      (preserveLock && initialOrientationLockState === "locked") ||
      (restoreAutomaticRotation && initialOrientationLockState === "unlocked") ||
      (!preserveLock && !restoreAutomaticRotation)
    );
  }

  async handleAlreadyAppliedOrientation(
    orientation: "portrait" | "landscape",
    value: number,
    currentOrientation: string,
    {
      autoRotateState,
      plan,
    }: {
      autoRotateState: "locked" | "enabled" | "unknown";
      plan: {
        preserveLock: boolean;
        restoreAutomaticRotation: boolean;
        beforeWrite: RotationCallSettings["beforeWrite"];
        cleanup: RotationSettingCleanup;
        signal?: AbortSignal;
      };
    },
  ): Promise<AlreadyAppliedOrientationDecision> {
    const { preserveLock, restoreAutomaticRotation, beforeWrite, cleanup, signal } = plan;
    throwIfAborted(signal);
    if (currentOrientation !== orientation) {
      return { kind: "requires-rotation", reason: "orientation-differs" };
    }

    const initialOrientationLockState: OrientationLockState =
      autoRotateState === "locked"
        ? "locked"
        : autoRotateState === "enabled"
          ? "unlocked"
          : "unknown";
    if (
      this.shouldReturnAlreadyAppliedOrientation(
        preserveLock,
        restoreAutomaticRotation,
        initialOrientationLockState,
      )
    ) {
      return {
        kind: "handled",
        result: {
          success: true,
          orientation,
          value,
          currentOrientation,
          previousOrientation: currentOrientation,
          rotationPerformed: false,
          orientationLockHandled: false,
          orientationLockState: initialOrientationLockState,
          message: `Device is already in ${orientation} orientation`,
        },
      };
    }

    if (preserveLock) {
      return this.lockAlreadyAppliedOrientation(orientation, value, currentOrientation, {
        options: { beforeWrite, cleanup },
        signal,
      });
    }

    if (!restoreAutomaticRotation) {
      return { kind: "requires-rotation", reason: "orientation-differs" };
    }

    await beforeWrite({ accelerometerRotation: true });
    // Auto-rotate was not on, so any lock the device-state map records for this state is cleared.
    cleanup.deviceStateLock = { kind: "clear" };
    const { achievedOrientation, warning } = await this.restoreAutoRotateAndConfirmOrientation(
      orientation,
      signal,
      cleanup,
    );
    const orientationLockState = await this.reader.getOrientationLockState(signal);
    if (orientationLockState !== "unlocked" && achievedOrientation !== "unknown") {
      return {
        kind: "handled",
        result: {
          success: false,
          orientation,
          value,
          currentOrientation: achievedOrientation,
          previousOrientation: currentOrientation,
          rotationPerformed: false,
          orientationLockHandled: true,
          orientationLockState,
          error: `Automatic rotation could not be confirmed as restored (orientation lock is ${orientationLockState}).`,
        },
      };
    }
    const error =
      achievedOrientation === "unknown"
        ? "The end orientation could not be confirmed after restoring automatic rotation."
        : undefined;
    return {
      kind: "handled",
      result: {
        success: error === undefined,
        error,
        orientation,
        value,
        currentOrientation: achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: false,
        orientationLockHandled: true,
        orientationLockState,
        warning,
        message:
          error ?? `Restored automatic rotation; device is currently ${achievedOrientation}.`,
      },
    };
  }

  resolveAutoRotatePlan(
    autoRotateState: "locked" | "enabled" | "unknown",
    lockOrientation: boolean | undefined,
    sessionMode = false,
  ): AutoRotatePlan {
    const preserveLock = lockOrientation === true;
    const restoreAutomaticRotation = lockOrientation === false;
    const wasAutoRotateEnabled = autoRotateState === "enabled";
    const restoreAfterConfirmation =
      sessionMode && lockOrientation === undefined && wasAutoRotateEnabled;
    return {
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
      shouldRestoreAutoRotate:
        restoreAutomaticRotation ||
        (wasAutoRotateEnabled && !preserveLock && !restoreAfterConfirmation),
      // A session's omitted lock used to persist until release. Restore it only
      // after a confirmed rotation, preserving its existing unknown/error policy.
      restoreAfterConfirmation,
      canForceAutoRotateOff: lockOrientation !== undefined || autoRotateState !== "unknown",
    };
  }

  logAutoRotatePlan(
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

  /** Direct failed locks restore prior automatic rotation; sessions own restoration on release. */
  async restoreAutoRotateAfterFailedLock(
    result: RotateResult,
    plan: AutoRotatePlan,
    settings: RotationCallSettings,
    { cleanup, sessionMode }: { cleanup: RotationSettingCleanup; sessionMode: boolean },
  ): Promise<RotateResult> {
    if (
      result.success ||
      sessionMode ||
      !settings.started ||
      !plan.preserveLock ||
      !plan.wasAutoRotateEnabled
    ) {
      return result;
    }
    try {
      await this.store.restoreAutoRotateSetting(cleanup);
    } catch (error) {
      logger.warn("Failed to restore auto-rotate after failed lock", error);
      result.warning = [result.warning, `Failed to restore auto-rotate: ${error}`]
        .filter(Boolean)
        .join(" ");
    }
    return result;
  }

  async finalizeAndroidRotation(options: AndroidRotationResultOptions): Promise<RotateResult> {
    const {
      orientation,
      value,
      currentOrientation,
      achievedOrientation,
      warning,
      restoreConfirmed,
      preserveLock,
      restoreAutomaticRotation,
      wasAutoRotateEnabled,
      signal,
    } = options;
    throwIfAborted(signal);
    const orientationLockState = await this.reader.getOrientationLockState(signal);
    const rotationPerformed = currentOrientation !== orientation;
    if (achievedOrientation === "unknown") {
      const error = "The end orientation could not be confirmed after restoring auto-rotate.";
      return {
        success: false,
        orientation,
        value,
        currentOrientation: "unknown",
        previousOrientation: currentOrientation,
        rotationPerformed,
        orientationLockHandled: wasAutoRotateEnabled,
        orientationLockState,
        warning: warning ?? error,
        error,
        message: error,
      };
    }
    if (preserveLock && orientationLockState !== "locked") {
      // Auto-rotate may already have restored the sensor-held orientation.
      // Reuse the bounded live read; stale user_rotation cannot confirm it.
      const confirmation = await this.confirmOrientationAfterAutoRotateRestore(
        orientation,
        false,
        signal,
      );
      return {
        success: false,
        orientation,
        value,
        currentOrientation: confirmation.achievedOrientation,
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
    if (achievedOrientation !== orientation) {
      const cause = restoreConfirmed
        ? "auto-rotate reverted it"
        : `after attempting to restore auto-rotate, it was confirmed ${achievedOrientation}; auto-rotate may have reverted it`;
      const error = `Requested ${orientation}, but the device is actually in ${achievedOrientation}; ${cause}. Pass lockOrientation: true to keep the requested ${orientation} orientation.`;
      return {
        success: false,
        orientation,
        value,
        currentOrientation: achievedOrientation,
        previousOrientation: currentOrientation,
        rotationPerformed: achievedOrientation !== currentOrientation,
        orientationLockHandled: wasAutoRotateEnabled,
        orientationLockState,
        warning,
        error,
        message: error,
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
        ? this.buildRotationMessage(orientation, currentOrientation, achievedOrientation, {
            warning,
            restoreConfirmed,
          })
        : `Locked device orientation to ${orientation}.`,
    };
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
  async confirmOrientationAfterAutoRotateRestore(
    requestedOrientation: "portrait" | "landscape",
    restoreConfirmed: boolean,
    signal?: AbortSignal,
  ): Promise<{ achievedOrientation: string; warning: string | undefined }> {
    throwIfAborted(signal);
    const liveRotationValue = await this.reader.readLiveRotationWithSettleWait(
      requestedOrientation,
      signal,
      POST_RESTORE_SETTLE_PROFILE,
    );
    if (liveRotationValue === null) {
      return {
        achievedOrientation: "unknown",
        warning: this.buildConfirmationWarning(requestedOrientation, restoreConfirmed, null),
      };
    }

    const achievedOrientation = await this.reader.orientationOfRotation(liveRotationValue, signal);
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
  async restoreAutoRotateAndConfirmOrientation(
    requestedOrientation: "portrait" | "landscape",
    signal?: AbortSignal,
    cleanup: RotationSettingCleanup = { needed: false },
  ): Promise<{
    achievedOrientation: string;
    warning: string | undefined;
    restoreConfirmed: boolean;
  }> {
    let restoreWriteError: unknown;
    try {
      await this.store.restoreAutoRotateSetting(cleanup);
    } catch (firstError) {
      // A single transient failure (e.g. a momentary CtrlProxy/ADB hiccup)
      // must not be treated as ambiguous on its own — retry once, the same
      // idempotent write, before falling back to the ambiguous-outcome path
      // (#6211 review).
      logger.debug(
        `[Rotate] accelerometer_rotation restore write failed on first attempt, retrying once: ${firstError}`,
      );
      try {
        await this.store.restoreAutoRotateSetting(cleanup);
      } catch (retryError) {
        restoreWriteError = retryError;
        logger.warn(
          `[Rotate] accelerometer_rotation restore write failed after retry (ambiguous outcome) after confirming rotation to ${requestedOrientation}: ${retryError}`,
        );
      }
    }

    if (signal?.aborted && restoreWriteError !== undefined) {
      throw new ActionableError(
        "Rotation cancelled; accelerometer_rotation may be left changed (auto-rotate may remain disabled)",
        { cause: restoreWriteError },
      );
    }
    const restoreConfirmed = restoreWriteError === undefined;
    const { achievedOrientation, warning: confirmWarning } =
      await this.confirmOrientationAfterAutoRotateRestore(
        requestedOrientation,
        restoreConfirmed,
        signal,
      );
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
  buildRotationMessage(
    requestedOrientation: "portrait" | "landscape",
    previousOrientation: string,
    achievedOrientation: string,
    { warning, restoreConfirmed }: { warning?: string; restoreConfirmed: boolean },
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
}
